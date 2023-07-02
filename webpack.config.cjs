const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const FILEMOD_ASYNC_PATH = './src/filemod-async.node';
const FILEMOD_SYNC_PATH = './src/filemod-sync.node';

module.exports = {
  mode: 'production',
  entry: {
    index: './src/index.ts',
    worker: './src/worker.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
    library: {
      name: 'FileDispatcher',
      type: 'umd',
    },
    globalObject: 'this',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: ['babel-loader', 'ts-loader'],
        exclude: /node_modules/,
      },
      {
        test: /\.node$/,
        loader: 'node-loader',
      },
    ],
  },
  target: 'node',
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: FILEMOD_ASYNC_PATH, to: 'filemod-async.node' },
        { from: FILEMOD_SYNC_PATH, to: 'filemod-sync.node' },
      ],
    }),
  ],
};
