#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: amplify-apex-target.sh <branch-name>" >&2
  exit 64
fi

branch_name="$1"

jq -er \
  --arg branch "$branch_name" \
  '
    [
      .domainAssociation.subDomains[]?
      | select(
          (
            (.subDomainSetting | has("prefix") | not)
            or (
              (.subDomainSetting.prefix | type) == "string"
              and .subDomainSetting.prefix == ""
            )
          )
          and .subDomainSetting.branchName == $branch
        )
      | .dnsRecord
    ]
    | if length == 1
      then .[0]
      else error("missing unique apex DNS record")
      end
    | split(" ")
    | map(select(length > 0))
    | if length == 2 and .[0] == "CNAME"
      then .[1]
      else error("invalid apex DNS record")
      end
    | ascii_downcase
    | rtrimstr(".")
  '
