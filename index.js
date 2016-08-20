var sonos = require('sonos');
var Sonos = require('sonos').Sonos;
var Listener = require('sonos/lib/events/listener');
var xml2js = require('sonos/node_modules/xml2js');
var _ = require('underscore');
var inherits = require('util').inherits;
var url = require('url');

var PlatformAccessory, Service, Characteristic, UUIDGen, VolumeCharacteristic;

var sonosPlatform;
var sonosAccessories = new Map();
var sonosDevices = new Map();
var sonosGroups = new Map();
var sonosGroupMembers = new Map();
var sonosPlaylistAccessories = new Map();

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
  this.log = this._createLogger(log, 'Sonos');
  this.config = _.extend({
    port:   50200,
    suffix: ' Speaker',
    playlists: {}
  }, config);
  this.api = api;

  this.unregisterCachedAccessories = [];

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

  // Do we have any missing playlist accessories?
  // Do we need playlist accessories?
  for (var zone in this.config.playlists) {
    this._createPlaylistAccessories(zone);
  }

  // TODO: Handle devices that are REMOVED from the network and cleanup structures
};

// Configure a cached accessory
SonosPlatform.prototype.configureAccessory = function (platformAccessory) {
  if (platformAccessory.context.type == 'SonosPlaylistAccessory') {
    if (!this.config.playlists[platformAccessory.context.zone] ||
        !this.config.playlists[platformAccessory.context.zone][platformAccessory.context.uri]) {
      this.unregisterCachedAccessories.push(platformAccessory);
      return;
    }

    // Pull name out of configuration not cache in case it was changed
    var configName = platformAccessory.context.zone + ' ' + this.config.playlists[platformAccessory.context.zone][platformAccessory.context.uri].name;
    new SonosPlaylistAccessory(
      this.api,
      this._createLogger(this.log, configName),
      configName,
      platformAccessory.context.uri,
      this.config.playlists[platformAccessory.context.zone][platformAccessory.context.uri],
      platformAccessory.context.zone,
      platformAccessory
    );
    return;
  }

  platformAccessory.context.type = 'SonosAccessory';
  new SonosAccessory(
    this.api,
    this._createLogger(this.log, platformAccessory.context.name),
    platformAccessory.context.name,
    platformAccessory.context.zone,
    platformAccessory
  );
};

// Create a new sonos accessory and associated playlist accessories
SonosPlatform.prototype._createAccessory = function (zone) {
  var accessory = new SonosAccessory(
    this.api,
    this._createLogger(this.log, zone),
    zone + this.config.suffix,
    zone
  );

  // Do we need playlist accessories?
  if (this.config.playlists[zone]) {
    this._createPlaylistAccessories(zone);
  }

  return accessory;
};

// Create playlist accessories for a zone if they don't exist
SonosPlatform.prototype._createPlaylistAccessories = function (zone) {
  for (var uri in this.config.playlists[zone]) {
    var playlistList = sonosPlaylistAccessories.get(zone);
    if (playlistList !== undefined && playlistList.get(uri)) {
      return;
    }

    new SonosPlaylistAccessory(
      this.api,
      this._createLogger(this.log, zone),
      zone + ' ' + this.config.playlists[zone][uri].name,
      uri,
      this.config.playlists[zone][uri],
      zone
    );
  }
};

// Update reachability of an accessory that we found and any associated playlist
// accessories
SonosPlatform.prototype._updateReachability = function (accessory, value) {
  accessory.log('Accessory is now reachable');
  accessory.platformAccessory.updateReachability(true);

  // Process playlist accessories
  var playlistList = sonosPlaylistAccessories.get(accessory.zone);
  if (playlistList !== undefined) {
    playlistList.forEach(function (playlistAccessory, uri) {
      playlistAccessory.log('Accessory is now reachable');
      playlistAccessory.platformAccessory.updateReachability(true);
    }.bind(this));
  }
};

// Create a logger for an accessory
SonosPlatform.prototype._createLogger = function (log, prefix) {
  return function () {
    var args = Array.from(arguments);
    args[0] = '[' + prefix + '] ' + args[0];
    log.apply(null, args);
  };
};

// Logging helper - will log device messages under its accessory if it has one
SonosPlatform.prototype._log = function (data) {
  var args = Array.from(arguments).slice(1);
  if (data.accessory) {
    data.accessory.log.apply(data.accessory.log, args);
    return;
  }
  this.log.apply(null, args);
};

// Search for devices on the local network
SonosPlatform.prototype._processDiscovery = function (device, model) {
  this.log('Found device at %s', device.host);

  if (sonosDevices.get(device.host) !== undefined) {
    // We know this device already
    return;
  }

  // Process this new device's topology, adding all other devices from it and
  // registering event handlers
  this._processTopology(device);
};

// Process group management events that occur when group changes happen
SonosPlatform.prototype._processEvent = function (endpoint, sid, eventData, device) {
  if (endpoint == '/GroupManagement/Event') {
    // A group management event occurred - check for topology changes
    // TODO: We receive events multiple times, once from each device -
    //       an optimisation would be to track which devices know each other
    //       (would that be ALL on the network?) and only register for
    //       group events one time
    this._processTopology(device);
    return;
  }

  var data = sonosDevices.get(device.host);
  if (data === undefined) {
    this.log('Event received from undiscovered device at %s', device.host);
    return;
  } else if (!data.accessory) {
    this.log('Event received from device without accessory at %s', device.host);
    return;
  }

  this._parseEvent(eventData, function (err, eventStruct) {
    if (err) {
      this._log(data, 'Invalid event received: %s', err);
      return;
    }

    if (endpoint == '/MediaRenderer/AVTransport/Event') {
      // Ignore if not coordinator - probably means this device just left the
      // group and is now coordinating another group. So let's let the topology
      // update happen which will request another event by re-registering
      if (data.coordinator !== 'true') {
        this._log(data, 'Ignoring AV event from non-coordinator device');
        return;
      }

      // Play state change event occurred
      this._processAVEvent(data, eventStruct);
      return;
    }

    if (endpoint == '/MediaRenderer/RenderingControl/Event') {
      // Volume change event occurred
      this._processRenderingEvent(data, eventStruct);
      return;
    }
  }.bind(this));
};

// Process an event structure and parse the XML
SonosPlatform.prototype._parseEvent = function (eventData, callback) {
  // Validate the event structure
  if (eventData.LastChange === undefined) {
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
SonosPlatform.prototype._processTopology = function (device) {
  this.log('Starting topology update from device at %s', device.host);

  device.getTopology(function (err, topology) {
    if (err || !topology) {
      this.log('Topology update from device at %s failed: %s', device.host, err);
      return;
    }

    // For each zone, register the device orupdate the name, group and coordinator
    // and for new devices setup event handlers
    topology.zones.forEach(function (group) {
      var urlObj = url.parse(group.location),
          host = urlObj.hostname,
          port = urlObj.port,
          data = sonosDevices.get(host);

      if (data === undefined) {
        // New device, setup initial data, the rest will be updated below
        data = {
          host: host,
          port: port,
          sonos: new Sonos(host, port)
        };

        // Register for events and store the new device
        this.listener.addService('/GroupManagement/Event', function () {}, data.sonos);
        this.listener.addService('/MediaRenderer/AVTransport/Event', function () {}, data.sonos);
        this.listener.addService('/MediaRenderer/RenderingControl/Event', function () {}, data.sonos);
        sonosDevices.set(host, data);

        this.log('Registered new device at %s:%s', host, port);
      }

      this._log(data, 'Processing topology for device at %s', host);

      // Set/update zone name for this device and associated accessory
      if (group.name !== data.name) {
        var accessory = sonosAccessories.get(group.name);

        if (data.accessory) {
          data.accessory.log('Associated device has been renamed to zone %s - accessory is now unavailable', group.name);
          data.accessory.device = undefined;
        }

        if (accessory) {
          this._updateReachability(accessory, true);
        } else {
          accessory = this._createAccessory(group.name);
        }

        data.name = group.name;
        data.accessory = accessory;

        if (accessory.device) {
          accessory.log('Associated device has changed from %s to %s', accessory.device.host, host);
          accessory.device.accessory = undefined;
        } else {
          accessory.log('Associated device discovered at %s', host);
        }
        accessory.device = data;
      }

      // Set/update the group information - and the group map that locates coordinators
      if (group.coordinator !== data.coordinator) {
        if (data.coordinator === 'true') {
          this._log(data, 'Device in zone %s is no longer the coordinator of group %s', data.name, data.group);
          sonosGroups.delete(data.group);
        }

        data.coordinator = group.coordinator;

        if (data.coordinator === 'true') {
          if (sonosGroups.get(group.group) === undefined) {
            this._log(data, 'Device in zone %s is now coordinator of group %s', data.name, group.group);
          }
          sonosGroups.set(group.group, data);
        }
      }

      if (group.group !== data.group) {
        var groupList,
            coordinator = sonosGroups.get(group.group);

        if (data.group) {
          groupList = sonosGroupMembers.get(data.group);
          this._log(data, 'Device in zone %s is no longer a member of group %s', data.name, data.group);
          if (groupList !== undefined) {
            groupList.delete(data.host);
          }

          var previousGroupCoordinator = sonosGroups.get(data.group);
          if (previousGroupCoordinator) {
            // If the old coordinator is the same as this one - move it
            if (previousGroupCoordinator.host == data.host) {
              sonosGroups.delete(data.group);
              sonosGroups.set(group.group, data);
              coordinator = previousGroupCoordinator;
            } else {
              // Request a new AV event for the previous group's coordinator as possibly
              // some of the playlist accessories need turning on if the coordinator is
              // now standalone
              this.listener.addService('/MediaRenderer/AVTransport/Event', function () {}, previousGroupCoordinator.sonos);
            }
          }
        }

        data.group = group.group;
        groupList = sonosGroupMembers.get(data.group);
        if (groupList === undefined) {
          groupList = new Map();
          sonosGroupMembers.set(data.group, groupList);
        }
        groupList.set(data.host, data);

        if (coordinator === undefined) {
          this._log(data, 'Device in zone %s is now a member of group %s with no known coordinator', data.name, data.group);
        } else {
          this._log(data, 'Device in zone %s is now a member of group %s with coordinator in zone %s', data.name, data.group, coordinator.name);

          // Trigger a fresh event from the coordinator so we update power states of this device
          // correctly as it may have sent its AV event before we updated topology, and it would
          // have been dropped due to it not being a coordinator
          this.listener.addService('/MediaRenderer/AVTransport/Event', function () {}, coordinator.sonos);
        }
      }
    }.bind(this));

    this.log('Topology update from device %s completed', device.host);
  }.bind(this));
};

// Process a state change event
SonosPlatform.prototype._processAVEvent = function (data, eventStruct) {
  var value, queueUri;
  if (eventStruct.TransportState && eventStruct.TransportState[0].$.val == "PLAYING") {
    value = true;
  } else {
    value = false;
  }

  if (eventStruct['r:EnqueuedTransportURI']) {
    queueUri = eventStruct['r:EnqueuedTransportURI'][0].$.val;
  } else {
    queueUri = '';
  }

  this._log(data, 'State is now %s and queue URI is now "%s"', value, queueUri);

  var groupList = sonosGroupMembers.get(data.group);
  if (!groupList) {
    return;
  }

  // Update power state of all group members
  groupList.forEach(function (memberData) {
    if (!data.accessory) {
      return;
    }

    this._log(memberData, 'Updating power characteristic to %s', value);
    memberData.accessory.service.getCharacteristic(Characteristic.On).setValue(value, null, '_internal');

    // Process playlist accessories - mark as off if not a standalone group
    var playlistList = sonosPlaylistAccessories.get(memberData.name);
    if (playlistList !== undefined) {
      playlistList.forEach(function (playlistAccessory, uri) {
        var playlistValue,
            expectedUri = 'x-rincon-cpcontainer:10062a6c' + uri.replace(/:/g, '%3a');
        if (queueUri == expectedUri && groupList.size == 1) {
          playlistValue = true;
        } else {
          playlistValue = false;
        }
        playlistAccessory.log('Updating power characteristic to %s for playlist uri %s', playlistValue, uri);
        playlistAccessory.service.getCharacteristic(Characteristic.On).setValue(playlistValue, null, '_internal');
      }.bind(this));
    }
  }.bind(this));
};

SonosPlatform.prototype._processRenderingEvent = function (data, eventStruct) {
  var value;
  eventStruct.Volume.forEach(function (item) {
    if (item.$.channel == 'Master') {
      value = item.$.val;
    }
  });

  this._log(data, 'Updating volume characteristic to %s for device in zone %s', value, data.name);
  data.accessory.service.getCharacteristic(VolumeCharacteristic).setValue(value, null, '_internal');
};

//
// Sonos Playlist Accessory
//

function SonosPlaylistAccessory(api, log, name, uri, config, zone, platformAccessory) {
  this.api = api;
  this.log = log;
  this.name = name;
  this.uri = uri;
  this.config = config;
  this.zone = zone;

  if (platformAccessory === undefined) {
    this.log('Creating new playlist platform accessory with name %s and URI %s', name, uri);
    platformAccessory = new PlatformAccessory(name, UUIDGen.generate(name));
    platformAccessory.context.type = 'SonosPlaylistAccessory';
    platformAccessory.context.uri = uri;
    platformAccessory.context.zone = zone;
    this.service = platformAccessory.addService(Service.Switch, name);
  } else {
    this.log('Restoring cached playlist platform accessory with name %s and URI %s', name, uri);
    this.platformAccessory = platformAccessory;
    this.service = platformAccessory.getService(Service.Switch);
  }

  this.service
    .getCharacteristic(Characteristic.On)
    .on('set', this.setOn.bind(this));

  var playlistList = sonosPlaylistAccessories.get(zone);
  if (playlistList === undefined) {
    playlistList = new Map();
    sonosPlaylistAccessories.set(zone, playlistList);
  }
  playlistList.set(uri, this);

  if (!this.platformAccessory) {
    this.platformAccessory = platformAccessory;
    this.api.registerPlatformAccessories('homebridge-sonos', 'Sonos', [platformAccessory]);
  }
}

SonosPlaylistAccessory.prototype._getDevice = function () {
  var accessory = sonosAccessories.get(this.zone);
  if (!accessory) {
    return false;
  }

  return accessory.device;
};

SonosPlaylistAccessory.prototype.setOn = function(on, callback, context) {
  if (context == '_internal') {
    // An internal status update - don't do anything
    callback(null);
    return;
  }

  var device = this._getDevice();
  if (!device) {
    this.log('Ignoring request; Sonos device has not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  if (on) {
    this.log('Starting playlist request for %s', this.uri);
  } else {
    this.log('Clearing playlist from %s', this.uri);
  }

  var groupList = sonosGroups.get(device.group);
  if (groupList === undefined || groupList.size == 1) {
    this._configurePlaylist(on, device, callback);
    return;
  }

  device.sonos.becomeCoordinatorOfStandaloneGroup(function (err) {
    if (err) {
      this.log('Standalone group request failed: %s', err);
      callback(err);
      return;
    }

    this._configurePlaylist(on, device, callback);
  }.bind(this));
};

// Process the queue URI and play the playlist
SonosPlaylistAccessory.prototype._configurePlaylist = function (on, device, callback) {
  device.sonos.flush(function (err) {
    if (err) {
      this.log('Queue flush request failed: %s', err);
      callback(err);
      return;
    }

    if (!on) {
      // If we are switching off we only clear the queue
      callback(null);
      return;
    }

    device.sonos.queue({
      uri: 'x-rincon-cpcontainer:10062a6c' + this.uri.replace(/:/g, '%3a'),
      metadata: '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
                '<item id="10062a6c' + this.uri.replace(/:/g, '%3a') + '"  restricted="true"><dc:title>New</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON2311_X_#Svc2311-0-Token</desc></item></DIDL-Lite>'
    }, function (err) {
      if (err) {
        this.log('Playlist queue request failed: %s', err);
        callback(err);
        return;
      }

      if (this.config.volume === undefined) {
        this._play(device, callback);
        return;
      }

      // Set the volume before we start playing
      device.sonos.setVolume(this.config.volume, function (err) {
        if (err) {
          this.log('Volume request failed: %s', err);
          callback(err);
          return;
        }

        this._play(device, callback);
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

SonosPlaylistAccessory.prototype._play = function (device, callback) {
  device.sonos.setPlayMode('SHUFFLE_NOREPEAT', function (err) {
    if (err) {
      this.log('Play mode request failed: %s', err);
      callback(err);
      return;
    }

    device.sonos.play(function (err) {
      if (err) {
        this.log('Play request failed: %s', err);
        callback(err);
        return;
      }

      if (this.config.sleepTimer === undefined) {
        this.log('Playlist %s successfully played', this.uri);
        callback(null);
        return;
      }

      this._configureSleepTimer(device, callback);
    }.bind(this));
  }.bind(this));
};

SonosPlaylistAccessory.prototype._configureSleepTimer = function (device, callback) {
  var action = '"urn:schemas-upnp-org:service:AVTransport:1#ConfigureSleepTimer"',
      body = '<u:ConfigureSleepTimer xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><NewSleepTimerDuration>' + this.config.sleepTimer + '</NewSleepTimerDuration></u:ConfigureSleepTimer>',
      responseTag = 'u:ConfigureSleepTimerResponse';
  device.sonos.request(device.sonos.options.endpoints.transport, action, body, responseTag, function (err, data) {
    if (err) {
      this.log('Sleep timer request failed: %s', err);
      callback(err);
      return;
    }

    this.log('Playlist %s successfully played', this.uri);
    callback(null);
  }.bind(this));
};

//
// Sonos Accessory
//

function SonosAccessory(api, log, name, zone, platformAccessory) {
  this.api = api;
  this.log = log;
  this.name = name;
  this.zone = zone;

  if (sonosAccessories.get(zone) !== undefined) {
    throw new Error('Duplicate accessory for zone ' + zone + ' in use.');
  }

  if (platformAccessory === undefined) {
    this.log('Creating new platform accessory with name %s', name);
    platformAccessory = new PlatformAccessory(name, UUIDGen.generate(name));
    platformAccessory.context.type = 'SonosAccessory';
    platformAccessory.context.name = name;
    platformAccessory.context.zone = zone;
    this.service = platformAccessory.addService(Service.Switch, name);
  } else {
    this.log('Restoring cached platform accessory with name %s', name);
    this.platformAccessory = platformAccessory;
    this.service = platformAccessory.getService(Service.Switch);
  }

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

  sonosAccessories.set(zone, this);

  if (!this.platformAccessory) {
    this.platformAccessory = platformAccessory;
    this.api.registerPlatformAccessories('homebridge-sonos', 'Sonos', [platformAccessory]);
  }
}

SonosAccessory.prototype._getCoordinator = function() {
  if (!this.device) {
    return false;
  }

  var coordinator = sonosGroups.get(this.device.group);
  if (coordinator === undefined) {
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

  var state = on ? 'play' : 'stop';
  this.log('Starting %s request via coordinator %s', state, coordinator.name);

  coordinator.sonos[state](this._setOnCallback.bind(this, state, callback));
};

SonosAccessory.prototype._setOnCallback = function (what, callback, err, success) {
  this.log('Completed %s request with result: %s', what, success);

  if (err) {
    callback(err);
    return;
  }

  callback(null);
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

  var coordinator = this._getCoordinator();
  if (!coordinator) {
    this.log('Ignoring request; Sonos device has not yet been discovered.');
    callback(new Error('Sonos has not been discovered yet.'));
    return;
  }

  this.log('Setting volume to %s', volume);

  this.device.sonos.setVolume(volume, function(err, data) {
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
