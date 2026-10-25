# Records assets/dbmole-demo.gif with vhs (https://github.com/charmbracelet/vhs).
# The OWNER runs it: it drives a real, logged-in Claude Code session (costs tokens, output
# varies) against a throwaway local demo database. Not run by CI.
#   1. npm run build && assets/demo/dbmole-up.sh
#      (Docker: PostgreSQL "shop" on 127.0.0.1:55432)
#   2. vhs assets/dbmole-demo.tape          (from the repo root; registers the local build in
#      a temp dir's local scope and removes it afterwards)
#   3. If the answer is cut off or wrong, tune the Sleep values or re-record; commit the GIF.
#   4. assets/demo/dbmole-up.sh down
# Run vhs from a plain shell, not from inside another Claude Code session.
Output assets/dbmole-demo.gif
Require claude
Require node

Set Shell "bash"
Set FontSize 18
Set Width 1400
Set Height 820
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Framerate 20

Hide
Type "R=$(pwd) D=$(mktemp -d) && cd $D && git init -q && printf '.dbmole.json\n' > .gitignore"
Enter
# Neutral settings for the demo, whatever the recorder's user settings say.
Type `mkdir .claude && echo '{"permissions":{"defaultMode":"default"},"language":"English","outputStyle":"default","statusLine":{"type":"command","command":"true"}}' > .claude/settings.local.json`
Enter
Type "claude mcp add dbmole -- node $R/packages/dbmole-mcp/dist/index.js > /dev/null && clear"
Enter
Sleep 3s
Show

# Pre-approve dbmole's tools so no permission prompt interrupts the recording.
Type "claude --allowedTools mcp__dbmole"
Enter
Sleep 5s
# Fresh directory: accept the workspace trust prompt ("Yes, I trust this folder").
Down
Sleep 500ms
Enter
Sleep 3s

Type "Add a readonly postgres connection 'shop' to this project: localhost:55432, database shop, user reporter, password demo. Then show the 5 largest tables."
Sleep 500ms
Enter
# Wait for the turn summary ("... for 17s · done 16:49"), then let the answer sit.
Wait+Screen@180s /done \d+:\d+/
Sleep 6s

# End the GIF on the answer, then quit and clean up off camera.
Hide
Type "/exit"
Sleep 500ms
Enter
Sleep 3s
Type "claude mcp remove dbmole -s local > /dev/null 2>&1; cd $R && rm -rf $D"
Enter
Sleep 2s
