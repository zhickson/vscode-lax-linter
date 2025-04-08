# Lighthouse Accessibility (LAX) Linter for VSCode


A VSCode extension that provides accessibility linting/hinting for HTML and PHP files using axe-core based on the [Google Lighthouse Accessibility scores](https://developer.chrome.com/docs/lighthouse/accessibility/scoring). This extension helps you identify accessibility issues in your code while you type.

A lot of other accessibility linters are available, but very few (if any) provide support for PHP files, or are specifically targeted to work with Google Lighthouse Accessibility checks.

> [!NOTE]
> This is a personal project, not sponsored by or associated with Google Lighthouse or the Los Angeles International Airport in any way :)

## Features

- Real-time accessibility checking for HTML and PHP files
- Integration with VSCode's native linting system
- Based on the Google Lighthouse Accessibility scoring system
- Detailed error messages with suggested fixes
- Configurable rule sets

## Installation

1. Install the extension from the VSCode Marketplace
2. Reload VSCode

## Usage

The extension will automatically start linting your HTML and PHP files when you open them. Accessibility issues will be highlighted in the editor with detailed information about the problem and how to fix it.

### Configuration

You can configure the extension through VSCode's settings:

```json
{
  "laxLinter.enabled": true,
  "laxLinter.run": "onSave|onType",
  "laxLinter.rules": [],
  "laxLinter.debounceDelay": 500,
  "laxLinter.maxFileSize": 0,
  "laxLinter.includedLanguages": [], // NOT SUPPORTED YET
}
```

- `laxLinter.enabled`: Enable/disable the linter
- `laxLinter.run`: Select either "onSave" (default) or "onType" for when the linting happens
- `laxLinter.rules`: Array of specific axe-core rule IDs to enable/disable
- `laxLinter.debounceDelay`: The debounce delay in milliseconds for linting the current doc (500ms default)
- `laxLinter.maxFileSize`: Maximum file size to lint (in bytes), default is unlimited (0)
- `laxLinter.includedLanguages`: Array of specific language IDs to lint (NOT SUPPORTED YET, HTML and PHP files only)

## Development

To build and run the extension locally:

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press F5 to start debugging

## Requirements

- VSCode 1.85.0 or higher
- Node.js 16.x or higher

## License

MIT

## WISHLIST
- [] Improve the accuracy of linting error reporting/highlighting
- [] Add support for more languages natively, such as JSX/React, etc.

## Changelog

TBC