import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const swaggerSpec = load(
    fs.readFileSync(path.join(__dirname, '../swagger.yaml'), 'utf8')
);

export default swaggerSpec;