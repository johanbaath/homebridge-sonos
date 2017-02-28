var sonos = require('sonos');
var Sonos = require('sonos').Sonos;
var Listener = require('sonos/lib/events/listener');
var xml2js = require('xml2js');
var _ = require('underscore');
var inherits = require('util').inherits;
var url = require('url');

var PlatformAccessory, Service, Characteristic, UUIDGen, VolumeCharacteristic;

module.exports = function (homebridge) {
  PlatformAccessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  // we can only do this after we receive the homebridge API object
  makeVolumeCharacteristic();

  // Dynamically create accessories
  homebridge.registerPlatform('homebridge-sonos', 'Sonos', SonosPlatform, true);
};

// SonosPlatform handles device discovery and various events
function SonosPlatform(log, config, api) {
  this.log = log;
  this.config = _.extend({
    port: 50200,
    suffix: ' Speaker',
    spotify_rincon_id: '2311',
    scenes: {}
  }, config);
  this.api = api;

  this.unregisterCachedAccessories = [];

  // {zone: accessory}
  this.accessories = new Map();
  // {host: device}
  this.devices = new Map();
  // {group: coordinatorDevice}
  this.groups = new Map();
  // {group: {host: device}}
  this.groupMembers = new Map();
  // {name: accessory}
  this.sceneAccessories = new Map();
  // {zone: {name: accessory}}
  this.zoneSceneAccessories = new Map();

  this.api.on('didFinishLaunching', this._didFinishLaunching.bind(this));
}

// Homebridge has finished launching and restoring cached accessories, start
// discovery processes
SonosPlatform.prototype._didFinishLaunching = function() {
  // Global listener we receive notifications from Sonos devices on
  this.listener = new Listener(undefined, {port: this.config.port});
  this.listener.listen(function (listenErr) {
    if (listenErr) {
      throw new Error('Failed to initialise event listener for homebridge-sonos');
    }

    this.listener.on('serviceEvent', this._processEvent.bind(this));

    // Don't start searching until listener is ready for event registrations
    this.log('Searching for Sonos devices');
    sonos.search({port: this.config.port}, this._processDiscovery.bind(this));
  }.bind(this));

  // Remove unwanted cached accessories
  if (this.unregisterCachedAccessories.length !== 0) {
    this.api.unregisterPlatformAccessories('homebridge-sonos', 'Sonos', this.unregisterCachedAccessories);
    this.unregisterCachedAccessories = [];
  }

  // Do we have any missing scene accessories?
  for (var name in this.config.scenes) {
    var sceneAccessory = this.sceneAccessories.get(name);
    if (sceneAccessory) {
      continue;
    }

    new SonosSceneAccessory(
      this,
      this._createLogger('Scene:' + name),
      name,
      this.config.scenes[name]
    );
  }

  // TODO: Handle devices that are REMOVED from the network and cleanup structures
};

// Configure a cached accessory
SonosPlatform.prototype.configureAccessory = function (platformAccessory) {
  if (platformAccessory.context.type == 'SonosSceneAccessory') {
    var sceneConfig = this.config.scenes[platformAccessory.context.name];
    if (!sceneConfig) {
      this.unregisterCachedAccessories.push(platformAccessory);
      return;
    }

    new SonosSceneAccessory(
      this,
      this._createLogger('Scene:' + platformAccessory.context.name),
      platformAccessory.context.name,
      sceneConfig,
      platformAccessory
    );
    return;
  }

  if (platformAccessory.context.type == 'SonosAccessory') {
    new SonosAccessory(
      this,
      this._createLogger(platformAccessory.context.name),
      platformAccessory.context.name,
      platformAccessory.context.zone,
      platformAccessory
    );
    return;
  }

  // Unknown accessory type
  this.unregisterCachedAccessories.push(platformAccessory);
};

// Update reachability of an accessory that we found and any associated scene
// accessories
SonosPlatform.prototype._updateReachability = function (accessory, value) {
  if (value === accessory.platformAccessory.reachable) {
    return;
  }

  if (value) {
    accessory.log('Accessory is now reachable');
  } else {
    accessory.log('Accessory is no longer reachable');
  }

  accessory.platformAccessory.updateReachability(value);

  // Process scene accessories
  var sceneList = this.zoneSceneAccessories.get(accessory.zone);
  if (!sceneList) {
    return;
  }

  sceneList.forEach(function (sceneAccessory) {
    if (value === sceneAccessory.platformAccessory.reachable) {
      return;
    }

    if (value) {
      sceneAccessory.log('Accessory is now reachable');
      sceneAccessory.platformAccessory.updateReachability(true);
      return;
    }

    // Before removing reachability - check if any other zones are available
    this._updateSceneUnreachability(sceneAccessory, accessory.zone);
  }.bind(this));
};

// Check that there is still a reachable zone in the scene, removing reachability
// if there is not
SonosPlatform.prototype._updateSceneUnreachability = function (sceneAccessory, unreachableZone) {
  var isReachable = false;

  for (var i in sceneAccessory.sceneConfig.zones) {
    var zone = sceneAccessory.sceneConfig.zones[i];

    if (zone == unreachableZone) {
      continue;
    }

    var zoneAccessory = this.accessories.get(zone);
    if (!zoneAccessory || !zoneAccessory.device) {
      continue;
    }

    isReachable = true;
    break;
  }

  if (isReachable) {
    return;
  }

  sceneAccessory.log('Accessory is no longer reachable');
  sceneAccessory.platformAccessory.updateReachability(false);
};

// Create a logger for an accessory
SonosPlatform.prototype._createLogger = function (prefix) {
  var log = this.log;
  return function () {
    var args = Array.from(arguments);
    args[0] = '[' + prefix + '] ' + args[0];
    log.apply(null, args);
  };
};

// Logging helper - will log device messages under its accessory if it has one
SonosPlatform.prototype._log = function (deviceData) {
  var args = Array.from(arguments).slice(1);
  if (deviceData.accessory) {
    deviceData.accessory.log.apply(deviceData.accessory.log, args);
    return;
  }
  this.log.apply(null, args);
};

// Search for devices on the local network
SonosPlatform.prototype._processDiscovery = function (device, model) {
  this.log('Found device at %s', device.host);

  if (this.devices.get(device.host)) {
    // We know this device already
    return;
  }

  // Process this new device's topology, adding all other devices from it and
  // registering event handlers
  this.updateTopology(device);
};

// Process group management events that occur when group changes happen
SonosPlatform.prototype._processEvent = function (endpoint, sid, eventData, device) {
  if (endpoint == '/GroupManagement/Event') {
    // A group management event occurred - check for topology changes
    // TODO: We receive events multiple times, once from each device -
    //       an optimisation would be to track which devices know each other
    //       (would that be ALL on the network?) and only register for
    //       group events one time
    this.updateTopology(device);
    return;
  }

  var deviceData = this.devices.get(device.host);
  if (!deviceData) {
    this.log('Event received from undiscovered device at %s', device.host);
    return;
  } else if (!deviceData.accessory) {
    this.log('Event received from device without accessory at %s', device.host);
    return;
  }

  this._parseEvent(eventData, function (err, eventStruct) {
    if (err) {
      this._log(deviceData, 'Invalid event received: %s', err);
      return;
    }

    if (endpoint == '/MediaRenderer/AVTransport/Event') {
      // Ignore if not coordinator - probably means this device just left the
      // group and is now coordinating another group. So let's let the topology
      // update happen which will request another event by re-registering
      if (deviceData.coordinator !== 'true') {
        this._log(deviceData, 'Ignoring AV event from non-coordinator device');
        return;
      }

      // Play state change event occurred
      this._processAVEvent(deviceData, eventStruct);
      return;
    }

    if (endpoint == '/MediaRenderer/RenderingControl/Event') {
      // Volume change event occurred
      this._processRenderingEvent(deviceData, eventStruct);
      return;
    }
  }.bind(this));
};

// Process an event structure and parse the XML
SonosPlatform.prototype._parseEvent = function (eventData, callback) {
  // Validate the event structure
  if (!eventData.LastChange) {
    callback(new Error('Invalid event structure received'));
    return;
  }

  // Parse XML
  (new xml2js.Parser()).parseString(eventData.LastChange, function (err, didl) {
    if (err) {
      callback(err);
      return;
    }

    callback(null, didl.Event.InstanceID[0]);
  });
};

// Process topology data for a device
SonosPlatform.prototype.updateTopology = function (device, callback) {
  this.log('Starting topology update from device at %s', device.host);

  device.getTopology(function (err, topology) {
    if (err || !topology) {
      this.log('Topology update from device at %s failed: %s', device.host, err);
      callback(err ? err : new Error('Invalid topology data'));
      return;
    }

    // For each zone, register the device orupdate the name, group and coordinator
    // and for new devices setup event handlers
    topology.zones.forEach(function (topologyZone) {
      var urlObj = url.parse(topologyZone.location),
          host = urlObj.hostname,
          port = urlObj.port,
          deviceData = this.devices.get(host);

      if (!deviceData) {
        // New device, setup initial data, the rest will be updated below
        deviceData = {
          host: host,
          port: port,
          sonos: new Sonos(host, port),
          // The following are stubs that document the available data
          name: undefined,
          coordinator: undefined,
          queueUri: '',
          group: undefined,
          uuid: undefined
        };

        // Register for events and store the new device
        this.listener.addService('/GroupManagement/Event', function () {}, deviceData.sonos);
        this.listener.addService('/MediaRenderer/AVTransport/Event', function () {}, deviceData.sonos);
        this.listener.addService('/MediaRenderer/RenderingControl/Event', function () {}, deviceData.sonos);
        this.devices.set(host, deviceData);

        this.log('Registered new device at %s:%s', host, port);
      }

      this._log(deviceData, 'Processing topology for device at %s', host);

      // Set/update zone name for this device and associated accessory
      if (topologyZone.name !== deviceData.name) {
        var accessory = this.accessories.get(topologyZone.name);

        if (deviceData.accessory) {
          deviceData.accessory.log('Associated device has been renamed to zone %s - accessory is now unavailable', topologyZone.name);
          deviceData.accessory.setDeviceData(undefined);
          this._updateReachability(deviceData.accessory, false);
        }

        if (accessory) {
          this._updateReachability(accessory, true);
        } else {
          accessory = new SonosAccessory(
            this,
            this._createLogger(topologyZone.name),
            topologyZone.name + this.config.suffix,
            topologyZone.name
          );
        }

        deviceData.name = topologyZone.name;
        deviceData.accessory = accessory;

        if (accessory.device) {
          accessory.log('Associated device has changed from %s to %s', accessory.device.host, host);
          accessory.device.accessory = undefined;
        } else {
          accessory.log('Associated device discovered at %s', host);
        }
        accessory.setDeviceData(deviceData);
      }

      // Set/update the group information - and the group map that locates coordinators
      if (topologyZone.coordinator !== deviceData.coordinator) {
        if (deviceData.coordinator === 'true') {
          this._log(deviceData, 'Device in zone %s is no longer the coordinator of group %s', deviceData.name, deviceData.group);
          this.groups.delete(deviceData.group);
          deviceData.queueUri = '';
        }

        deviceData.coordinator = topologyZone.coordinator;

        if (deviceData.coordinator === 'true') {
          var previousCoordinator = this.groups.get(topologyZone.group);
          if (previousCoordinator) {
            // Ensure we lose the coordinator flag on the previous coordinator as
            // otherwise if we encounter the flag change after this we'll corrupt indexes
            this._log(previousCoordinator, 'Device in zone %s is no longer coordinator of group %s', previousCoordinator.name, topologyZone.group);
            previousCoordinator.coordinator = 'false';
          } else {
            this._log(deviceData, 'Device in zone %s is now coordinator of group %s', deviceData.name, topologyZone.group);
          }
          this.groups.set(topologyZone.group, deviceData);
        }
      }

      if (topologyZone.group !== deviceData.group) {
        var groupList,
            coordinator = this.groups.get(topologyZone.group);

        if (deviceData.group) {
          groupList = this.groupMembers.get(deviceData.group);
          this._log(deviceData, 'Device in zone %s is no longer a member of group %s', deviceData.name, deviceData.group);
          if (groupList) {
            groupList.delete(deviceData.host);
            if (groupList.size === 0) {
              this.groupMembers.delete(deviceData.group);
            }
          }

          var previousGroupCoordinator = this.groups.get(deviceData.group);
          if (previousGroupCoordinator) {
            // If the old coordinator is the same as this one - move it
            if (previousGroupCoordinator.host == deviceData.host) {
              this.groups.delete(deviceData.group);
              this.groups.set(topologyZone.group, deviceData);
              coordinator = previousGroupCoordinator;
            } else {
              // Request a new AV event for the previous group's coordinator as possibly
              // some of the playlist accessories need turning on if the topology now matches
              this.listener.addService('/MediaRenderer/AVTransport/Event', function () {}, previousGroupCoordinator.sonos);
            }
          }
        }

        deviceData.group = topologyZone.group;
        groupList = this.groupMembers.get(deviceData.group);
        if (!groupList) {
          groupList = new Map();
          this.groupMembers.set(deviceData.group, groupList);
        }
        groupList.set(deviceData.host, deviceData);

        if (!coordinator) {
          this._log(deviceData, 'Device in zone %s is now a member of group %s with no known coordinator', deviceData.name, deviceData.group);
        } else {
          this._log(deviceData, 'Device in zone %s is now a member of group %s with coordinator in zone %s', deviceData.name, deviceData.group, coordinator.name);

          // Trigger a fresh event from the coordinator so we update power states of this device
          // correctly as it may have sent its AV event before we updated topology, and it would
          // have been dropped due to it not being a coordinator
          this.listener.addService('/MediaRenderer/AVTransport/Event', function () {}, coordinator.sonos);
        }
      }

      if (topologyZone.uuid != deviceData.uuid) {
        deviceData.uuid = topologyZone.uuid;
        this._log(deviceData, 'Device in zone %s is now UUID %s', deviceData.name, deviceData.uuid);
      }
    }.bind(this));

    this.log('Topology update from device %s completed', device.host);
    if (callback) {
      callback(null);
    }
  }.bind(this));
};

// Process a state change event
SonosPlatform.prototype._processAVEvent = function (deviceData, eventStruct) {
  var value, queueUri;
  if (!eventStruct.TransportState) {
    value = false;
    textValue = 'FAILED';
  } else if (eventStruct.TransportState[0].$.val == "PLAYING") {
    value = true;
    textValue = 'PLAYING';
  } else {
    value = false;
    textValue = eventStruct.TransportState[0].$.val;
  }

  if (eventStruct['r:EnqueuedTransportURI']) {
    queueUri = eventStruct['r:EnqueuedTransportURI'][0].$.val;
  } else {
    queueUri = '';
  }

  deviceData.queueUri = queueUri;

  this._log(deviceData, 'State is now %s (%s) and queue URI is now "%s"', textValue, value, queueUri);

  var groupList = this.groupMembers.get(deviceData.group);
  if (!groupList) {
    return;
  }

  // Update power state of all group members
  groupList.forEach(function (memberDeviceData) {
    if (!deviceData.accessory) {
      return;
    }

    memberDeviceData.accessory.updateOn(value);
  }.bind(this));

  // Process scene accessories involving this zone
  var sceneList = this.zoneSceneAccessories.get(deviceData.name);
  if (sceneList) {
    sceneList.forEach(function (sceneAccessory, name) {
      var powerState = value;

      // If turning something on - check if we should turn on the scene switch
      if (powerState) {
        powerState = this._calculateScenePowerState(sceneAccessory, deviceData);
      }

      sceneAccessory.updateOn(powerState);
    }.bind(this));
  }
};

SonosPlatform.prototype._calculateScenePowerState = function (sceneAccessory, deviceData) {
  // Check playlist matches before allowing it to turn on
  if (!sceneAccessory.isDevicePlayingSceneUri(deviceData)) {
    return false;
  }

  // Check the topology is correct
  if (!sceneAccessory.validateTopology(deviceData)) {
    return false;
  }

  return true;
};

SonosPlatform.prototype._processRenderingEvent = function (deviceData, eventStruct) {
  var value = 0;
  if (eventStruct.Volume) {
    eventStruct.Volume.forEach(function (item) {
      if (item.$.channel == 'Master') {
        value = item.$.val;
      }
    });
  }

  this._log(deviceData, 'Updating volume characteristic to %s for device in zone %s', value, deviceData.name);
  deviceData.accessory.service.getCharacteristic(VolumeCharacteristic).setValue(value, null, '_internal');
};

//
// Transition utilities
//

// Get a transition status from the transition table
function _utilGetTransition(characteristic) {
  if (!this.transitions) {
    this.transitions = new Map();
  }

  var transition = this.transitions.get(characteristic.UUID);
  if (!transition) {
    transition = {};
    this.transitions.set(characteristic.UUID, transition);
  }

  return transition;
}

// Handle an internal update, checking for active transitions
function _utilUpdateInternal(characteristic, value, quiet) {
  var transition = _utilGetTransition.call(this, characteristic),
      characteristicObj = this.service.getCharacteristic(characteristic);

  // Are we transitioning?
  if (!transition.isRunning) {
    // Compare with the existing value so we avoid unnecessary changes and logging
    // This is valid as HAP-NodeJS documents cacheable value as accessible directly
    // We don't call getValue as it triggers our listeners
    if (characteristicObj.value == value) {
      return;
    }

    // Log only if we're not a 'noisy' event (like power usage that happens every second)
    if (!quiet) {
      this.log('Updating %s characteristic to %s', characteristicObj.displayName, value);
    }

    // Set the value with internal context so our listeners ignores it but so we
    // still trigger change events to propogate to remote listeners (accessing
    // the cached value propertly directly doesn't do this)
    characteristicObj.setValue(value, null, '_internal');
    return;
  }

  this.log('Deferring %s characteristic update to %s as it is currently transitioning', characteristicObj.displayName, value);
  transition.deferred = value;
}

// Begin transition of a characteristic
// Prevents internal updates from taking effect until a second after the
// transition completes, to prevent flicking of states while status converges
function _utilBeginTransition(characteristic, callback) {
  var transition = _utilGetTransition.call(this, characteristic);

  transition.isRunning = true;

  // If we have a deferred timeout running already, clear it
  if (transition.deferredTimeout !== undefined) {
    clearTimeout(transition.deferredTimeout);
    transition.deferredTimeout = undefined;
  }

  return function (err) {
    // Set a timer to update to any deferred value after a small timeout that
    // will hopefully be long enough for events to converge on the desired state
    transition.deferredTimeout = setTimeout(function () {
      transition.isRunning = false;
      if (transition.deferred === undefined) {
        return;
      }

      this._updateInternal(characteristic, transition.deferred);
      transition.deferred = undefined;
    }.bind(this), 2000);

    callback(err);
  }.bind(this);
}

//
// Sonos Scene Accessory
//

function SonosSceneAccessory(platform, log, name, sceneConfig, platformAccessory) {
  this.platform = platform;
  this.log = log;
  this.name = name;
  this.sceneConfig = sceneConfig;

  if (platformAccessory) {
    this.log('Restoring cached scene platform accessory with name %s', name);
    this.platformAccessory = platformAccessory;
    this.infoService = platformAccessory.getService(Service.AccessoryInformation);
    this.service = platformAccessory.getService(Service.Switch);
  } else {
    this.log('Creating new scene platform accessory with name %s', name);
    platformAccessory = new PlatformAccessory(name, UUIDGen.generate(name));
    platformAccessory.context.type = 'SonosSceneAccessory';
    platformAccessory.context.name = name;
    this.infoService = platformAccessory.getService(Service.AccessoryInformation);
    this.service = platformAccessory.addService(Service.Switch);
  }

  this.infoService
    .setCharacteristic(Characteristic.Name, name)
    .setCharacteristic(Characteristic.Manufacturer, 'homebridge-sonos')
    .setCharacteristic(Characteristic.Model, 'Scene Accessory')
    .setCharacteristic(Characteristic.SerialNumber, 'N/A');

  this.service
    .getCharacteristic(Characteristic.On)
    .on('set', this.setOn.bind(this));

  // Index for quick lookup
  platform.sceneAccessories.set(name, this);
  sceneConfig.zones.forEach(function (zone) {
    var sceneList = platform.zoneSceneAccessories.get(zone);
    if (!sceneList) {
      sceneList = new Map();
      platform.zoneSceneAccessories.set(zone, sceneList);
    }
    sceneList.set(name, this);
  }.bind(this));

  if (!this.platformAccessory) {
    this.platformAccessory = platformAccessory;
    this.platform.api.registerPlatformAccessories('homebridge-sonos', 'Sonos', [platformAccessory]);
  }
}

// Common utils
SonosSceneAccessory.prototype._updateInternal = _utilUpdateInternal;
SonosSceneAccessory.prototype._beginTransition = _utilBeginTransition;

// Update current power state
SonosSceneAccessory.prototype.updateOn = function (on) {
  this._updateInternal(Characteristic.On, on);
};

// Fetch the coordinator device associated with this scene, or the first one
// listed
SonosSceneAccessory.prototype._getCoordinator = function () {
  var firstAccessoryDevice = false;

  for (var i in this.sceneConfig.zones) {
    var zone = this.sceneConfig.zones[i];
        accessory = this.platform.accessories.get(zone);

    if (firstAccessoryDevice === false && accessory) {
      firstAccessoryDevice = accessory.device;
    }
    if (accessory.device && accessory.device.coordinator === 'true') {
      return accessory.device;
    }
  }

  return firstAccessoryDevice;
};

// Handle power state
SonosSceneAccessory.prototype.setOn = function (on, callback, context) {
  if (context == '_internal') {
    // An internal status update - don't do anything
    callback(null);
    return;
  }

  var device = this._getCoordinator();
  if (!device) {
    this.log('Ignoring request; Sonos devices have not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  // Flag that a transition is happening so we can prevent status updates until
  // we complete
  callback = this._beginTransition(Characteristic.On, callback);

  if (!on) {
    this.log('Pausing coordinator');
    device.sonos.pause(function (err) {
      if (err) {
        this.log('Pause request failed: %s', err);
        callback(err);
        return;
      }

      this.log('Pause request successful');
      callback(null);
    }.bind(this));
    return;
  }

  // Validate the group is correct
  if (this.validateTopology(device)) {
    this.log('Starting scene request with existing group coordinator: %s', device.name);
    if (this.isDevicePlayingSceneUri(device)) {
      if (this.sceneConfig.volume) {
        this._configureVolume(device, callback);
        return;
      }
      this._play(device, callback);
      return;
    }
    this._configurePlaylist(device, callback);
    return;
  }

  this.log('Starting scene request by forming new group with new coordinator: %s', device.name);

  // Group is wrong - take the current device as the coordinator and configure
  // the others
  device.sonos.becomeCoordinatorOfStandaloneGroup(function (err) {
    if (err) {
      this.log('Standalone group request failed: %s', err);
      callback(err);
      return;
    }

    if (this.sceneConfig.zones.length == 1) {
      this._configurePlaylist(device, callback);
      return;
    }

    this.log('New coordinator in %s is now configured', device.name);

    this.platform.updateTopology(device.sonos, function (err) {
      if (err) {
        this.log('Topology update failed: %s', err);
        callback(err);
        return;
      }

      this._configureTopology(device, callback);
    }.bind(this));
  }.bind(this));
};

// Validate that the topology of the group containing the given device matches
// what we need for this scene
SonosSceneAccessory.prototype.validateTopology = function (device) {
  // Grab the device list for this zone
  var groupList = this.platform.groupMembers.get(device.group);
  if (!groupList) {
    return false;
  }

  // Compare the list with our zone list, ignoring unavailable zones
  var missingList = new Map(groupList);

  for (var i in this.sceneConfig.zones) {
    var zone = this.sceneConfig.zones[i],
        zoneAccessory = this.platform.accessories.get(zone);

    if (!zoneAccessory || !zoneAccessory.device) {
      // Unavailable zone, ignore it so we can still use the switch
      continue;
    }

    // Is the required zone in the group?
    if (!missingList.get(zoneAccessory.device.host)) {
      // We have a missing zone and need to recreate the group
      return false;
    }

    missingList.delete(zoneAccessory.device.host);
  }

  if (missingList.size !== 0) {
    // Not valid - need to create new group
    return false;
  }

  return true;
};

// Returns true if the given device is currently playing the requested URI
SonosSceneAccessory.prototype.isDevicePlayingSceneUri = function (device) {
  var expectedUri = 'x-rincon-cpcontainer:10062a6c' + this.sceneConfig.playlist.replace(/:/g, '%3a');
  return device.queueUri === expectedUri;
};

// Configure the other devices in the scene configuration to use our coordinator
SonosSceneAccessory.prototype._configureTopology = function (device, callback) {
  var topologyUpdateStack = [],
      stagedCallback = function (zone, err) {
        if (err) {
          this.log('Topology change request for %s failed: %s', zone, err);
          callback(err);
          return;
        }

        this.log('New topology with coordinator %s now includes %s', device.name, zone);
        var next = topologyUpdateStack.shift();
        if (next) {
          next();
          return;
        }

        this.log('Topology configuration has completed');
        this._configurePlaylist(device, callback);
      };

  this.sceneConfig.zones.forEach(function (zone) {
    if (zone == device.name) {
      return;
    }

    // Skip unavailable zones so we can function partially
    var zoneAccessory = this.platform.accessories.get(zone);
    if (!zoneAccessory || !zoneAccessory.device) {
      this.log('Skipping configuration of zone %s as it is unreachable', zone);
      return;
    }

    topologyUpdateStack.push(function () {
      zoneAccessory.device.sonos.queueNext('x-rincon:' + device.uuid, stagedCallback.bind(this, zone));
    }.bind(this));
  }.bind(this));

  // Begin updating the topology one by one
  // Never do this in parallel as it confuses Sonos if any of the target zones
  // are grouped as when we remove one zone from a group the other members begin
  // to re-elect a coordinator for that group and if we try to change their
  // membership while that happens - they'll pretty much just ignore us
  topologyUpdateStack.shift()();
};

// Process the queue URI and play the playlist
SonosSceneAccessory.prototype._configurePlaylist = function (device, callback) {
  device.sonos.flush(function (err) {
    if (err) {
      this.log('Queue flush request failed: %s', err);
      callback(err);
      return;
    }

    device.sonos.queue({
      uri: 'x-rincon-cpcontainer:10062a6c' + this.sceneConfig.playlist.replace(/:/g, '%3a'),
      metadata: '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
                '<item id="10062a6c' + this.sceneConfig.playlist.replace(/:/g, '%3a') + '"  restricted="true"><dc:title>New</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON' + this.platform.config.spotify_rincon_id + '_X_#Svc' + this.platform.config.spotify_rincon_id + '-0-Token</desc></item></DIDL-Lite>'
    }, function (err) {
      if (err) {
        this.log('Playlist queue request failed: %s', err);
        callback(err);
        return;
      }

      this.log('Playlist has been configured on coordinator %s', device.name);

      if (this.sceneConfig.volume) {
        this._configureVolume(device, callback);
        return;
      }

      this._play(device, callback);
    }.bind(this));
  }.bind(this));
};

// Configure volume level
SonosSceneAccessory.prototype._configureVolume = function (device, callback) {
  var callbackCount = 0,
      lastErr,
      collectCallback = function (err) {
        if (err) {
          this.log('Volume request failed: %s', err);
          if (!lastErr) {
            lastErr = err;
          }
        }

        if (--callbackCount === 0) {
          if (lastErr) {
            callback(lastErr);
            return;
          }
          this._play(device, callback);
        }
      }.bind(this);

  // Set the volume before we start playing
  for (var zone in this.sceneConfig.volume) {
    if (zone == device.name) {
      // Configure coordinator volume
      callbackCount++;
      device.accessory.setVolume(this.sceneConfig.volume[zone], collectCallback);
      continue;
    }

    // Skip unavailable zones so we can function partially
    var zoneAccessory = this.platform.accessories.get(zone);
    if (!zoneAccessory || !zoneAccessory.device) {
      this.log('Skipping volume of zone %s as it is unreachable', zone);
      continue;
    }

    callbackCount++;
    zoneAccessory.setVolume(this.sceneConfig.volume[zone], collectCallback);
  }
};

// Set play mode and start playing
SonosSceneAccessory.prototype._play = function (device, callback) {
  device.sonos.setPlayMode('SHUFFLE', function (err) {
    if (err) {
      this.log('Play mode request failed: %s', err);
      callback(err);
      return;
    }

    if (!device.accessory) {
      this.log('Sonos device became unreachable during play request');
      callback(new Error('Sonos device became unreachable'));
      return;
    }

    this.log('Coordinator in zone %s is now set to SHUFFLE', device.name);

    device.accessory.unmuteAndPlay(function (err) {
      if (err) {
        this.log('Unmute request failed: %s', err);
        callback(err);
        return;
      }

      if (!this.sceneConfig.sleepTimer) {
        this.log('Playlist %s successfully played', this.sceneConfig.playlist);
        callback(null);
        return;
      }

      this.log('Coordinator %s is now playing', device.name);

      this._configureSleepTimer(device, callback);
    }.bind(this));
  }.bind(this));
};

SonosSceneAccessory.prototype._configureSleepTimer = function (device, callback) {
  var action = '"urn:schemas-upnp-org:service:AVTransport:1#ConfigureSleepTimer"',
      body = '<u:ConfigureSleepTimer xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><NewSleepTimerDuration>' + this.sceneConfig.sleepTimer + '</NewSleepTimerDuration></u:ConfigureSleepTimer>',
      responseTag = 'u:ConfigureSleepTimerResponse';
  device.sonos.request(device.sonos.options.endpoints.transport, action, body, responseTag, function (err) {
    if (err) {
      this.log('Sleep timer request failed: %s', err);
      callback(err);
      return;
    }

    this.log('Playlist %s successfully played', this.sceneConfig.playlist);
    callback(null);
  }.bind(this));
};

//
// Sonos Accessory
//

function SonosAccessory(platform, log, name, zone, platformAccessory) {
  this.platform = platform;
  this.log = log;
  this.name = name;
  this.zone = zone;

  if (platform.accessories.get(zone)) {
    throw new Error('Duplicate accessory for zone ' + zone + ' in use.');
  }

  if (!platformAccessory) {
    this.log('Creating new platform accessory with name %s', name);
    platformAccessory = new PlatformAccessory(name, UUIDGen.generate(name));
    platformAccessory.context.type = 'SonosAccessory';
    platformAccessory.context.name = name;
    platformAccessory.context.zone = zone;
    this.infoService = platformAccessory.getService(Service.AccessoryInformation);
    this.service = platformAccessory.addService(Service.Switch);
  } else {
    this.log('Restoring cached platform accessory with name %s', name);
    this.platformAccessory = platformAccessory;
    this.infoService = platformAccessory.getService(Service.AccessoryInformation);
    this.service = platformAccessory.getService(Service.Switch);
  }

  this.infoService
    .setCharacteristic(Characteristic.Name, name)
    .setCharacteristic(Characteristic.Manufacturer, 'Sonos')
    .setCharacteristic(Characteristic.Model, 'Unknown')
    .setCharacteristic(Characteristic.SerialNumber, 'Unknown');

  this.service
    .getCharacteristic(Characteristic.On)
    .on('get', this.getOn.bind(this))
    .on('set', this.setOn.bind(this));

  var volumeCharacteristic = this.service.getCharacteristic(VolumeCharacteristic);
  if (!volumeCharacteristic) {
    volumeCharacteristic = this.service.addCharacteristic(VolumeCharacteristic);
  }

  volumeCharacteristic
    .on('get', this.getVolume.bind(this))
    .on('set', this.setVolume.bind(this));

  platform.accessories.set(zone, this);

  if (!this.platformAccessory) {
    this.platformAccessory = platformAccessory;
    this.platform.api.registerPlatformAccessories('homebridge-sonos', 'Sonos', [platformAccessory]);
  }
}

// Common utils
SonosAccessory.prototype._beginTransition = _utilBeginTransition;
SonosAccessory.prototype._updateInternal = _utilUpdateInternal;

// Update current power state
SonosAccessory.prototype.updateOn = function (on) {
  this._updateInternal(Characteristic.On, on);
};

// Set the device associated with this accessory
SonosAccessory.prototype.setDeviceData = function (deviceData) {
  this.device = deviceData;
  if (deviceData === undefined) {
    return;
  }

  // TODO: Once moved to node-ssdp we will have device model/serialNumber etc.
  //       and we should update characteristics and context here and call
  //       this.platform.api.updatePlatformAccessories to persist the new info
  //       to the homebridge cache - we should then initialise these values in
  //       the constructor from context
};

// Return the coordinator device which is controlling the stream this Sonos
// device is playing from (or itself if it is standalone)
SonosAccessory.prototype._getCoordinator = function() {
  if (!this.device) {
    return false;
  }

  var coordinator = this.platform.groups.get(this.device.group);
  if (!coordinator) {
    return false;
  }

  return coordinator;
};

SonosAccessory.prototype.getOn = function(callback) {
  var coordinator = this._getCoordinator();
  if (!coordinator) {
    this.log('Ignoring request; Sonos coordinator has not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  coordinator.sonos.getCurrentState(function (err, state) {
    if (err) {
      callback(err);
      return;
    }

    var playing = (state == 'playing');
    this.log('Current state: %s', playing);
    callback(null, playing);
  }.bind(this));
};

SonosAccessory.prototype.setOn = function(on, callback, context) {
  if (context == '_internal') {
    // An internal status update - don't do anything
    callback(null);
    return;
  }

  var coordinator = this._getCoordinator();
  if (!coordinator) {
    this.log('Ignoring request; Sonos device has not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  // Flag that a transition is happening so we can prevent status updates until
  // we complete
  callback = this._beginTransition(Characteristic.On, callback);

  var delegate, what;
  if (on) {
    delegate = coordinator.accessory.unmuteAndPlay.bind(coordinator.accessory);
    what = 'play';
  } else {
    delegate = coordinator.sonos.pause.bind(coordinator.sonos);
    what = 'pause';
  }

  this.log('Starting %s request via coordinator %s', what, coordinator.name);

  delegate(function (err) {
    if (err) {
      this.log('Device %s request failed: %s', what, err);
      callback(err);
      return;
    }

    this.log('Completed %s request', what);
    callback(null);
  }.bind(this));
};

SonosAccessory.prototype.unmuteAndPlay = function (callback) {
  if (!this.device || !this.device.coordinator) {
    this.log('Ignoring request; device is not a coordinator');
    callback(new Error('Device is not a coordinator'));
    return;
  }

  this.device.sonos.setMuted(false, function (err) {
    if (err) {
      this.log('Unmute request failed: %s', err);
      callback(err);
      return;
    }

    if (!this.device || !this.device.coordinator) {
      this.log('Coordinator changed during play request');
      callback(new Error('Coordinator changed during play request'));
      return;
    }

    this.log('Device is now unmuted');

    this.device.sonos.play(function (err) {
      if (err) {
        this.log('Play request failed: %s', err);
        callback(err);
        return;
      }

      callback(null);
    }.bind(this));
  }.bind(this));
};

SonosAccessory.prototype.getVolume = function(callback) {
  if (!this.device) {
    this.log('Ignoring request; Sonos device has not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  this.device.sonos.getVolume(function(err, volume) {
    if (err) {
      this.log('Current volume unknown: %s', err);
      callback(err);
      return;
    }

    this.log('Current volume: %s', volume);
    callback(null, Number(volume));
  }.bind(this));
};

SonosAccessory.prototype.setVolume = function(volume, callback, context) {
  if (context == '_internal') {
    // An internal status update - don't do anything
    callback(null);
    return;
  }

  if (!this.device) {
    this.log('Ignoring request; Sonos device has not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  this.log('Setting volume to %s', volume);

  this.device.sonos.setVolume(volume, function(err) {
    if (err) {
      this.log('Set volume failed: %s', err);
      callback(err);
      return;
    }

    this.log('Set volume successful: %s', volume);
    callback(null);
  }.bind(this));
};

//
// Custom Characteristic for Volume
//

function makeVolumeCharacteristic() {
  VolumeCharacteristic = function () {
    Characteristic.call(this, 'Volume', '91288267-5678-49B2-8D22-F57BE995AA93');
    this.setProps({
      format: Characteristic.Formats.INT,
      unit: Characteristic.Units.PERCENTAGE,
      maxValue: 100,
      minValue: 0,
      minStep: 1,
      perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
    });
    this.value = this.getDefaultValue();
  };

  inherits(VolumeCharacteristic, Characteristic);

  VolumeCharacteristic.UUID = '91288267-5678-49B2-8D22-F57BE995AA93';
}
