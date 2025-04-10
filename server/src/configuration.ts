import { Connection } from 'vscode-languageserver';

// Interface defining the structure of our settings
export interface LaxLinterSettings {
	enable: boolean;
	run: 'onType' | 'onSave';
	debounceDelay: number;
	includedLanguages: string[];
	maxFileSize: number; // in bytes, 0 for no limit
	axe: {
		tags: string[];
		rules: string[];
	};
}

// Default settings used when the client doesn't provide them
export const defaultSettings: LaxLinterSettings = {
	enable: true,
	run: 'onType',
	debounceDelay: 500,
	includedLanguages: ['html', 'php'],
	maxFileSize: 1048576, // 1MB
	axe: {
		tags: ['wcag2aa', 'wcag21aa', 'best-practice'],
		rules: {}
	}
};

// Cache for global settings
let globalSettings: LaxLinterSettings = defaultSettings;

// Cache for document-specific settings (currently unused but good practice)
const documentSettings: Map<string, Thenable<LaxLinterSettings>> = new Map();

let hasConfigurationCapability = false;

export function setConfigurationCapability(capability: boolean) {
	hasConfigurationCapability = capability;
}

export function clearDocumentSettings() {
	documentSettings.clear();
}

export function updateGlobalSettings(settings: LaxLinterSettings | undefined | null) {
	if (settings) {
		globalSettings = settings;
	} else {
		globalSettings = defaultSettings;
	}
}

export function getDocumentSettings(connection: Connection, resource: string): Thenable<LaxLinterSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'laxLinter'
		}).then(config => config || defaultSettings);
		documentSettings.set(resource, result);
	}
	return result;
}