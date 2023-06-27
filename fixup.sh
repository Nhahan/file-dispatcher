cp dist/mjs/file-dispatcher.d.ts dist

rm -rf dist/*/file-dispatcher.d.ts

cat >dist/cjs/package.json <<!EOF
{
    "type": "commonjs"
}
!EOF

cat >dist/mjs/package.json <<!EOF
{
    "type": "module"
}
!EOF