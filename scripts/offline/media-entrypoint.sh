#!/bin/sh
set -eu
umask 077
test "$(id -u)" = 0
test "$#" = 1
test "$1" = bt
# These tables belong only to this container's network namespace. No host network.
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4 172.81.57.10/32 15.204.56.108/32; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
done
iptables -A OUTPUT -j ACCEPT
# Drop all startup capabilities before parsing any external input.
exec setpriv --reuid=65532 --regid=65532 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all node /opt/nav/scripts/offline/media-runner.mjs bt
