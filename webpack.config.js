const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/file-dispatcher.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    library: 'FileDispatcher',
    libraryTarget: 'umd',
    globalObject: 'this',
  },
  module: {
    rules: [
      {
        test: /\.node$/,
        loader: 'node-loader',
      },
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }
    ],
  },
  resolve: {
    fallback: {
      fs: false,
      util: require.resolve('util'),
      path: require.resolve('path-browserify'),
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer'),
      os: require.resolve('os-browserify/browser'),
    },
    extensions: ['.ts', '.js'],
  },
};
