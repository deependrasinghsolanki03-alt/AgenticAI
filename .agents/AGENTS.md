# zCode Delegation Rule
Whenever the user asks to perform small, repetitive, or isolated coding tasks (e.g., formatting files, creating basic boilerplate scripts, fixing typos, or running simple checks), ALWAYS delegate them to the zCode IDE agent via the `push_task` tool exposed on the `zcode-bridge` MCP server.
Do not attempt to write the code yourself if the task is clearly delegable.
Once the task is pushed, schedule a timer to check the result or inform the user that the task has been queued for zCode.
