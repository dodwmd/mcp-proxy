# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) for version management and changelog generation.

## Adding a changeset

When you make changes that should be included in the changelog:

```bash
pnpm changeset
```

Follow the prompts to describe your changes.

## Publishing

Changesets are automatically processed during the release workflow in GitHub Actions.
