#!/bin/bash

set -e

PORTLINE="-p $NETSERVERPORT:$NETSERVERPORT -p $NETSERVERDATAPORT:$NETSERVERDATAPORT -p $NETSERVERDATAPORT:$NETSERVERDATAPORT/udp"
docker run $PORTLINE --net=calico -d --name=netserver netperf netserver -D -p $NETSERVERPORT

