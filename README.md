
# Sonos Platform

Example config.json:

```
{
  "platform": "Sonos",
  "suffix": " Speakers",
  "port": 50200,
  "playlists": {
      "Lounge": {
          "spotify:user:12345678:playlist:XXXXXXXXXXXXXXXXXXXXXX": {
              "name": "Party Music",
              "volume": 10,
              "sleepTimer": "2:00:00"
          },
          "spotify:user:username:playlist:XXXXXXXXXXXXXXXXXXXXXX": {
              "name": "Piano Collection"
          }
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

Adding `playlists` is also optional. Each entry inside it is the name of a
"zone" and within that a list of spotify playlists. A switch is created for each
combination and given a name formed by the zone followed by the "name"
specified. In the example above there will be a switch called "Lounge Party
Music". This switch will drop that zone from any group, replace the queue with
the given playlist, set the volume (in percentage - optional), a sleep timer
(in format `H:MM:SS`, also optional), set it to shuffle and then start it
playing.

*NOTE*: The `playlist` functionality only works for Spotify at this time. It is
also likely to only work within the UK or the European Union as the code is
hardcoded with an identifier that appears to be required to make it work there.
`node-sonos` on GitHub uses the US identifier so if anyone works out how to make
it autodetect - head over there and let's implement it!
