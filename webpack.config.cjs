const path = require('path');

module.exports = {
  mode: 'production',
  entry: {
    index: './src/index.ts',
    worker: './src/worker.js', // worker.js 파일 추가
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
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  target: 'node',
};
