#!/bin/bash

set -e

NETSERVERPORT=$1
NETSERVERDATAPORT=$2

PORTLINE="-p $NETSERVERPORT:$NETSERVERPORT -p $NETSERVERDATAPORT:$NETSERVERDATAPORT -p $NETSERVERDATAPORT:$NETSERVERDATAPORT/udp"
docker run $PORTLINE --net=host -d --name=netserver netperf netserver -D -p $NETSERVERPORT
