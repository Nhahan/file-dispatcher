#!/bin/bash

current_dir=$(pwd)

cd ./native

node-gyp configure
node-gyp build

cp ./build/Release/filemod.node $current_dir/src/filemod-sync.node
cp ./build/Release/filemod.node $current_dir/src/filemod-async.node

cd $current_dir
