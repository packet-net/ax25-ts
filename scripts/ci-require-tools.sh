#!/usr/bin/env bash
# ci-require-tools.sh: fail with one clear line per missing tool, naming the apt package.
#
#   scripts/ci-require-tools.sh dpkg-deb:dpkg readelf:binutils docker:docker.io
#   scripts/ci-require-tools.sh lib:libasound.so.2:libasound2t64/libasound2
#
# Each argument is <command> or <command>:<package>, or lib:<soname>:<package> for a shared
# library. Workflows call this on self-hosted runners for what no setup action provides. It never
# installs anything: that needs root, and a runner is not assumed to give us passwordless sudo.
set -u

# Is the shared library <soname> installed? ldconfig lives in /sbin or /usr/sbin, often off a
# normal user's PATH, so look there too; with no ldconfig at all, look in the usual directories.
have_lib() {
  local soname="$1" ldc d
  ldc="$(PATH="$PATH:/sbin:/usr/sbin" command -v ldconfig 2> /dev/null || true)"
  if [ -n "$ldc" ]; then
    "$ldc" -p 2> /dev/null | grep -qF "$soname" && return 0
  fi
  for d in /lib /usr/lib /lib64 /usr/lib64 /lib/*-linux-gnu /usr/lib/*-linux-gnu /usr/local/lib; do
    [ -e "$d/$soname" ] && return 0
  done
  return 1
}

missing=0
for spec in "$@"; do
  cmd="${spec%%:*}"
  pkg="${spec#*:}"
  if [ "$cmd" = lib ]; then
    soname="${pkg%%:*}"
    pkg="${pkg#*:}"
    if ! have_lib "$soname"; then
      echo "::error::this runner has no $soname: install the '$pkg' package (apt-get install $pkg)"
      missing=1
    fi
  elif ! command -v "$cmd" > /dev/null 2>&1; then
    echo "::error::this runner has no '$cmd': install the '$pkg' package (apt-get install $pkg)"
    missing=1
  fi
done
# docker on PATH is not docker usable: the daemon must answer for this account.
for spec in "$@"; do
  if [ "${spec%%:*}" = docker ] && command -v docker > /dev/null 2>&1 && ! docker info > /dev/null 2>&1; then
    echo "::error::docker is installed but this account cannot reach the daemon: start docker and add the runner user to the 'docker' group"
    missing=1
  fi
done
exit "$missing"
