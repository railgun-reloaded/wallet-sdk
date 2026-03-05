import fs from 'fs'

/**
 * Create directory from path
 * @param path - Input directory path
 */
function createDirectoryIfNotExists (path: string) {
  if (fs.existsSync(path)) {
    return
  }
  fs.mkdirSync(path, { recursive: true })
}

export { createDirectoryIfNotExists }
