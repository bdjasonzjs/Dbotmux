#!/bin/bash
# p5-marker.sh <node> <round> <role> <verdict PASS|NOT PASS|done>  → 打印 [p5:...]
cd "$(dirname "$0")"; python3 -c "
import sys; from p5lib import encode_marker
n,r,role,v=sys.argv[1:5]; assert v in ('PASS','NOT PASS','done'), 'verdict'
print(encode_marker({'node':n,'round':int(r),'role':role,'verdict':v}))" "$@"
