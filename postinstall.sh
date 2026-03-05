pushd . &&
cd node_modules/scanner &&
npm i && npm run build && 
popd && 
npm link @reloaded/storage @railgun-reloaded/note-commitment-indexer