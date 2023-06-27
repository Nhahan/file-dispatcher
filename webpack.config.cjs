const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/file-dispatcher.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    library: 'FileDispatcher',
    libraryTarget: 'commonjs2',
    globalObject: 'this',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  target: 'node',
};
