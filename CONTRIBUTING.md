# Contributing to BugSpotter SDK

Thank you for considering contributing to the BugSpotter SDK! This document outlines the process for contributing to this project.

## Development Setup

### Prerequisites
- Node.js 18+ (recommended: 18.x or 20.x)
- pnpm 8+
- Git

### Getting Started

1. **Fork and Clone**
   ```bash
   git clone https://github.com/your-username/bugspotter-sdk.git
   cd bugspotter-sdk
   ```

2. **Install Dependencies**
   ```bash
   pnpm install
   ```

3. **Build the Project**
   ```bash
   pnpm build
   ```

4. **Run Tests**
   ```bash
   # Unit tests
   pnpm test
   
   # E2E tests (requires browsers)
   pnpm test:e2e
   
   # Watch mode for development
   pnpm test:watch
   ```

## Project Structure

```
bugspotter-sdk/
├── packages/core/          # Main SDK package
│   ├── src/               # Source code
│   ├── tests/             # Unit tests
│   ├── docs/              # SDK documentation
│   └── scripts/           # Build scripts
├── examples/              # Integration examples
│   ├── react/             # React example
│   └── vanilla/           # Vanilla JS example
└── .github/               # GitHub workflows and templates
```

## Development Workflow

1. **Create a Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes**
   - Write code in `packages/core/src/`
   - Add tests in `packages/core/tests/`
   - Update documentation as needed

3. **Test Your Changes**
   ```bash
   pnpm test           # Unit tests
   pnpm test:e2e       # E2E tests
   pnpm lint           # Code linting
   pnpm format:check   # Code formatting
   ```

4. **Commit Changes**
   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature-name
   ```

## Code Style and Standards

### TypeScript Guidelines
- Use strict TypeScript settings
- Provide proper type annotations
- Avoid `any` types when possible
- Use interfaces for object shapes

### Code Formatting
- Use Prettier for formatting (automatic via `pnpm format`)
- Use ESLint for code quality (check via `pnpm lint`)
- Follow existing naming conventions

### Testing
- Write unit tests for all new functionality
- Maintain test coverage above 80%
- Add E2E tests for user-facing features
- Use descriptive test names and organize tests logically

### Commit Messages
Follow [Conventional Commits](https://conventionalcommits.org/):

- `feat: add new feature`
- `fix: bug fix`
- `docs: update documentation`
- `style: code formatting`
- `refactor: code refactoring`
- `test: add or update tests`
- `chore: maintenance tasks`

## Adding New Features

### Core SDK Features
1. Create feature in `packages/core/src/`
2. Add comprehensive tests
3. Update TypeScript types
4. Add documentation
5. Consider browser compatibility (ES2017+)

### Examples
1. Create new example in `examples/your-framework/`
2. Include `package.json` with dependencies
3. Add build configuration (Vite recommended)
4. Include README with setup instructions

## Testing

### Unit Tests
- Located in `packages/core/tests/`
- Use Vitest testing framework
- Mock external dependencies
- Test edge cases and error conditions

### E2E Tests
- Use Playwright for browser testing
- Test real browser interactions
- Verify SDK integration works end-to-end

### Test Commands
```bash
pnpm test                    # Run unit tests
pnpm test:watch             # Watch mode
pnpm test:coverage          # Coverage report
pnpm test:e2e               # E2E tests
pnpm test:e2e --headed      # E2E with browser UI
```

## Building and Publishing

### Local Development
```bash
pnpm dev     # Watch mode for development
pnpm build   # Production build
```

### Release Process
1. Update version in `packages/core/package.json`
2. Update `CHANGELOG.md` with changes
3. Create git tag: `git tag v0.3.1`
4. Push tag: `git push origin v0.3.1`
5. GitHub Actions will automatically publish to npm

## Pull Request Process

1. Fill out the PR template completely
2. Ensure all CI checks pass:
   - ✅ Tests pass
   - ✅ Linting passes
   - ✅ Build succeeds
   - ✅ Type checking passes
3. Request review from maintainers
4. Address feedback and update PR
5. Maintainer will merge after approval

## Code Review Criteria

- **Functionality**: Does the code work as intended?
- **Tests**: Are there adequate tests with good coverage?
- **Performance**: Does the change impact bundle size or performance?
- **Compatibility**: Works across supported browsers and Node versions?
- **Documentation**: Is the change properly documented?
- **Security**: No security vulnerabilities introduced?

## Getting Help

- **Questions**: Open a [Discussion](https://github.com/apex-bridge/bugspotter-sdk/discussions)
- **Bugs**: Open an [Issue](https://github.com/apex-bridge/bugspotter-sdk/issues) with the bug template
- **Features**: Open an [Issue](https://github.com/apex-bridge/bugspotter-sdk/issues) with the feature template
- **Security**: Email security@apexbridge.tech

## License

By contributing to BugSpotter SDK, you agree that your contributions will be licensed under the MIT License.