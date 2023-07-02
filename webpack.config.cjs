const path = require('path');

module.exports = {
  mode: 'production',
  entry: {
    index: './src/index.ts',
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
    extensions: ['.ts', '.js', '.node']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: ['babel-loader', 'ts-loader'],
        exclude: /node_modules/,
      },
    ],
  },
  target: 'node',
};