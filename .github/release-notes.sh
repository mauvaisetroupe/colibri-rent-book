#!/usr/bin/env bash
# Notes of a version for its GitHub Release (ADR 0026), written from git, nothing to write by hand: what the operator
# must read before deploying (commits marked « ! » or « BREAKING CHANGE: », Conventional Commits), the new migrations,
# then the commits since the previous version. Fails if a migration of the previous version was changed or removed:
# Flyway would refuse to migrate.
#   .github/release-notes.sh v1.1.0 > notes.md          (run by the CI on a tag; needs the whole history and the tags)
set -euo pipefail

tag=${1:?usage: release-notes.sh <tag vX.Y.Z>}
previous=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
range=${previous:+$previous..}$tag
MIGRATIONS=backend/migrations

if [ -n "$previous" ]; then
  changed=$(git diff --name-only --diff-filter=DMR "$previous" "$tag" -- "$MIGRATIONS/V*.sql")
  if [ -n "$changed" ]; then
    echo "Migrations of $previous changed or removed (Flyway would refuse to migrate):" >&2
    echo "$changed" >&2
    exit 1
  fi
  added=$(git diff --name-only --diff-filter=A "$previous" "$tag" -- "$MIGRATIONS/V*.sql")
else
  added=$(git ls-tree --name-only "$tag" "$MIGRATIONS/" | grep -E '/V[0-9]+__.+\.sql$' || true)
fi

# Commits marked breaking: « type!: » or « type(scope)!: » in the subject, or a « BREAKING CHANGE: » line
breaking=$(git log --no-merges --format='%H' "$range" | while read -r commit; do
  subject=$(git log -1 --format='%s' "$commit")
  footer=$(git log -1 --format='%b' "$commit" | sed -n 's/^BREAKING[ -]CHANGE: *//p')
  if [[ $subject =~ ^[a-z]+(\([^\)]*\))?!: ]] || [ -n "$footer" ]; then
    printf -- '- %s\n' "$subject"
    [ -z "$footer" ] || printf -- '  %s\n' "$footer"
  fi
done)

echo '## À lire avant de déployer'
echo
if [ -n "$breaking" ]; then
  echo "$breaking"
else
  echo 'Rien : aucune variable, aucune version de PostgreSQL, aucune action à faire à la main.'
fi
echo
echo '## Migrations'
echo
if [ -n "$added" ]; then
  # shellcheck disable=SC2001,SC2016  # one path per line; backquotes of Markdown
  sed 's|.*/|- `|; s|$|`|' <<<"$added"
  echo
  echo "Appliquées par l'image de migration de la même version, avant l'API ; sauvegarder la base d'abord."
else
  echo "Aucune : le schéma ne change pas, retour à ${previous:-la version précédente} possible sans restauration."
fi
echo
echo '## Changements'
echo
if [ -n "$previous" ]; then
  git log --no-merges --format='- %s' "$range"
  echo
  echo "Depuis $previous : https://github.com/mauvaisetroupe/colibri-rent-book/compare/$previous...$tag"
else
  echo "Première version publiée sous forme d'images ([documentation de l'exploitant](https://github.com/mauvaisetroupe/colibri-rent-book/blob/$tag/docs/exploitation.md))."
fi
