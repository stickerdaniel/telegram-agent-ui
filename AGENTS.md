# telegram-agent-ui

## Views

- A change that a view shows ships after a check in Telegram on the connected iPhone. Deploy the branch to the view host that Telegram opens, open a view of that change in Telegram on the iPhone with the `ghosthand` skill, and take screenshots of each changed state in light and dark. Zoom into the edges of every changed part: headless renders at 390 px have missed clipped and masked pixels there. The PR's Evidence section holds these iPhone screenshots, and the merge waits for them. A failed or abandoned check deploys `main` to that view host again.
