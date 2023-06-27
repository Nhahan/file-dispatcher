const path = require('path');

module.exports = {
  entry: './src/file-dispatcher.ts', // 진입 파일 경로
  output: {
    filename: 'index.js', // 번들 파일 이름
    path: path.resolve(__dirname) // 번들 파일이 생성될 디렉토리 경로
  },
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.ts$/, // 변환 대상 파일 확장자
        exclude: /node_modules/, // 변환 제외할 디렉토리
        use: {
          loader: 'babel-loader', // 바벨 로더 설정
          options: {
            presets: ['@babel/preset-env', '@babel/preset-typescript'] // 바벨 프리셋 설정
          }
        }
      }
    ]
  },
  resolve: {
    fallback: {
      "fs": false,
      "util": require.resolve("util/"),
      "path": require.resolve("path-browserify")
    },
    extensions: ['.ts', '.js']
  }
};
