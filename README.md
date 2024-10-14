
```bash
# install nodejs && npm -- needed for ota_server.local which is ota/server/server.js and runs from systemd on port 8090
# install avahi -- needed to pubish ota.local on multicast dns, starts in rc.local AFTER dhcp assignment

# images are stored in /opt/ota/images

$ mkdir -p /opt/ota && cd /opt/ota
$ git clone https://github.com/matthewgream/ota.git
$ cd ota
$ ( cd server && npm install )
$ sudo cp config/*.service /etc/systemd/system
$ if [ -f /etc/rc.local ]; then sudo echo systemctl start avahi-alias@ota.local >> /etc/rc.local; else sudo cp config/rc.local /etc/rc.local; fi
$ sudo systemctl start avahi-alias@ota.local
$ sudo systemctl enable ota_server && sudo systemctl start ota_server

$ ping ota.local
$ journalctl -au avahi-alias@ota.local
$ journalctl -au ota_server
$ curl http://ota.local:8090/images
```

