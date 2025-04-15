import * as fs from 'fs';
import * as path from 'path';

// Load the actual axe-core library from node_modules
// Use path.resolve with the project root to ensure we're looking in the right place
const projectRoot = path.resolve(__dirname, '../../');
const axePath = path.join(projectRoot, 'node_modules/axe-core/axe.min.js');

let axeSource: string;
try {
	axeSource = fs.readFileSync(axePath, 'utf8');
	console.log(`Successfully loaded axe-core from ${axePath}`);
} catch (error) {
	console.error(`Error loading axe-core from ${axePath}: ${error}`);
	axeSource = '';
}

export {
	axeSource,
};