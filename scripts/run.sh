#!/usr/bin/env bash
# One scheduled run: update cycling + all teams, publish to the "data" branch, and keep
# going every 5 minutes while anything is live or starting within 3 hours (max ~5h20m).
set -u
REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
BOT=(-c user.name="scoreboard-bot" -c user.email="41898282+github-actions[bot]@users.noreply.github.com")

mkdir -p data
if git fetch -q --depth 1 origin data 2>/dev/null; then git archive origin/data | tar -x -C data; fi

publish() {
  ( cd data && rm -rf .git && git init -q -b data && git add -A \
    && git "${BOT[@]}" commit -qm "Scoreboard data $(date -u +%FT%TZ)" \
    && git push -qf "$REPO_URL" data ) || echo "::warning::Couldn't publish data"
}

end=$((SECONDS + 5*3600 + 20*60))
while :; do
  python scripts/cycling.py || echo "::warning::cycling update failed"
  node scripts/build.js; code=$?
  export FULL=""            # only the first pass of a manual run rebuilds everything
  publish
  if [ "$code" -ne 10 ] || [ "$SECONDS" -ge "$end" ]; then break; fi
  echo "Something is live or starting soon; checking again in 5 minutes"
  sleep 300
done

# GitHub turns off scheduled jobs after 60 days without commits on the main branch
last=$(git log -1 --format=%ct)
if [ $(( $(date +%s) - last )) -gt $((45*86400)) ]; then
  git "${BOT[@]}" commit --allow-empty -qm "Keep scheduled updates enabled" && git push -q origin HEAD:main
fi

# Show a red X when a team has been failing (a phone alert has already gone out)
if [ -s data/problems.txt ]; then
  echo "::error::$(tr '\n' ' ' < data/problems.txt)"
  exit 1
fi
