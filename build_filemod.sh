#!/bin/bash

current_dir=$(pwd)

cd ./native

node-gyp configure
node-gyp build

mv ./build/Release/filemod.node $current_dir/src/
cd $current_dir
