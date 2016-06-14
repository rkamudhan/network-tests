#!/bin/bash

set -e

COMMON=$(dirname "${BASH_SOURCE[0]}")/../../common
. $COMMON/getoption

# only remove the network once, on the source, if it exists

if docker network ls | grep -wq calico; then
	docker network rm calico
fi
calicoctl node stop
calicoctl node remove


# remove firewall ports
IPRANGE=192.168.0.0/16

# open the firewall ports necessary
firewall-cmd --zone=trusted --remove-source=$IPRANGE