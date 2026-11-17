# a12s Studio

Run teams of AI agents on your own machine, built on [a12s](https://github.com/coltonkirsten/a12s).

Status: under construction.

## Backups

`scripts/setup.sh` installs a LaunchAgent, `com.a12s-studio.backup`, that runs `scripts/backup.ts` every night at
03:30. It copies both databases, `config.json`, the attachments and each agent's home drive into
`~/a12s-studio-backups/<date>/` and keeps the newest 14. Its log is `~/Library/Logs/a12s-studio/backup.log`. Run it
by hand with `node scripts/backup.ts`.

To restore: pause everything in Studio, stop it, put the backup back, and start it again.

```sh
launchctl bootout gui/$(id -u)/com.a12s-studio.app
launchctl bootout gui/$(id -u)/com.a12s-studio.broker
node scripts/restore.ts ~/a12s-studio-backups/<date> --force
scripts/setup.sh
```

Without `--force` the restore changes nothing when the data folder already holds Studio's data or the Fleet
already has a home drive that the backup would replace. The drives it loads are those of the Fleet the backup
names, also when `STUDIO_HOME` points at another folder.

The credentials the broker stores are encrypted with a vault key that lives in the login Keychain, not in the backup.
Export it once and keep it in your password manager; without it the stored credentials cannot be read on another
Mac. This copies the key to the clipboard, so it is never shown in the terminal:

```sh
security find-generic-password -s a12s-studio-broker -a vault-key -w | pbcopy
```

On another Mac, before Studio starts for the first time, import it (the command asks for the key):

```sh
security add-generic-password -s a12s-studio-broker -a vault-key -w
```
