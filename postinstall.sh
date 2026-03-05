pushd . &&
cd node_modules/@reloaded/storage &&
npm i && npm run build &&
popd &&
cd node_modules/scanner &&
npm i && npm run build