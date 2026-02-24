#!/bin/bash
cd /Users/timbot/.openclaw/workspace/commute-curator
export PATH=/opt/homebrew/bin:$PATH
export $(cat .env | xargs)
/opt/homebrew/bin/node commute-gen.js >> commute.log 2>&1
