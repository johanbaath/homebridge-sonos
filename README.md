
# Sonos Platform

*NOTE*: IMPORTANT - once installed you will need to REPLACE the
`node_modules/sonos` with https://github.com/driskell/node-sonos.git until the
required improvements made there are raised and merged.

Example config.json:

```
{
  "platform": "Sonos",
  "suffix": " Speakers",
  "port": 50200,
  "spotify_rincon_id": "2311",
  "scenes": {
      "Piano Collection": {
          "playlist": "spotify:user:12345678:playlist:XXXXXXXXXXXXXXXXXXXXXX",
          "zones": ["Lounge"],
          "volume": 10,
          "sleepTimer": "2:00:00"
      },
      "Party Music": {
          "playlist": "spotify:user:username:playlist:XXXXXXXXXXXXXXXXXXXXXX",
          "zones": ["Lounge", "Kitchen", "Hallway"]
      }
  }
}
```

The `suffix` parameter is optional and the default is shown above. In HomeKit
your devices will given a name formed from their zone followed by the suffix.
For example, a Sonos device in zone "Lounge" will be named "Lounge Speakers".

The `port` parameter is also optional. It specifies the port to listen on for
device discovery and communication. It uses both UDP and TCP so open this port
on your firewall for both.

The `spotify_rincon_id` is optional and defaults to "2311". It is not clear what
this value means but it is related to Spotify regions. In the UK (and possibly
the EU) the default of "2311" is fine. US citizens will need to set this to
"3079" for the playlists to work.

Adding `scenes` is also optional. Each entry inside it is the name of a switch
to create that will set a Sonos "scene". This includes forming a group, setting
a Spotify playlist, enabling shuffle, and optionally setting the volume and a
sleep timer. The sleep timer configuration must be in the format `H:MM:SS`,

*NOTE*: The `scenes` functionality only works for Spotify at this time.
