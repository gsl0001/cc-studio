// cc-studio's scheduled jobs. On Windows they are Task Scheduler entries that run as you
// while you're logged in (no admin needed); elsewhere this prints cron lines to use.
//
//   npm run tasks:install       register or update every task (and start the logon ones now)
//   npm run tasks:uninstall     stop and remove them
//   npm run tasks:install -- --list   show what would be registered
//
// Every Windows task runs `wscript.exe scripts\hidden.vbs <job>`: no console window to close
// by accident (a closed window takes the job down with it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/config.js";

const today = new Date().toLocaleDateString("sv");
const TASKS = [
  { job: "tick", about: "uploads the next due video through the platform's own scheduler, every 30 min from 08:00",
    trigger: `<CalendarTrigger><StartBoundary>${today}T08:00:00</StartBoundary><Repetition><Interval>PT30M</Interval><Duration>PT15H30M</Duration><StopAtDurationEnd>true</StopAtDurationEnd></Repetition><RandomDelay>PT8M</RandomDelay><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`,
    limit: "PT50M", catchUp: true, cron: "*/30 8-23 * * *", cmd: "node scripts/tick.mjs", log: "tick" },
  { job: "pulse", about: "the heartbeat: queues approved videos, starts the creator, checks logins and the bot, every 30 min",
    trigger: `<TimeTrigger><StartBoundary>${today}T00:00:00</StartBoundary><Repetition><Interval>PT30M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>`,
    limit: "PT20M", catchUp: true, cron: "*/30 * * * *", cmd: "node scripts/pulse.mjs", log: "pulse" },
  { job: "insights", about: "weekly metrics, the report, then next week's plan (Saturday 18:00)",
    trigger: `<CalendarTrigger><StartBoundary>${today}T18:00:00</StartBoundary><RandomDelay>PT10M</RandomDelay><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Saturday /></DaysOfWeek></ScheduleByWeek></CalendarTrigger>`,
    limit: "PT5H", catchUp: true, cron: "0 18 * * 6", cmd: "node scripts/weekly-insights.mjs", log: "insights" },
  { job: "bot", about: "the Telegram approval bot (at logon; restarted if it fails)", logon: true, restart: true,
    cron: "@reboot", cmd: "node scripts/telegram-bot.mjs", log: "telegram-bot" },
  { job: "desk", about: "the desk server cc and the browser widget talk to (at logon)", logon: true,
    cron: "@reboot", cmd: "node src/server.js", log: "desk" },
  { job: "cc", about: "cc, the desktop companion (at logon)", logon: true },
];
const name = (t) => `cc-studio ${t.job}`;
const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function xml(t) {
  const trigger = t.logon ? `<LogonTrigger><UserId>${esc(user)}</UserId></LogonTrigger>` : t.trigger;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${esc(`cc-studio: ${t.about}`)}</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>${t.limit ?? "PT0S"}</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    ${t.catchUp ? "<StartWhenAvailable>true</StartWhenAvailable>" : ""}
    ${t.restart ? "<RestartOnFailure><Count>999</Count><Interval>PT1M</Interval></RestartOnFailure>" : ""}
  </Settings>
  <Triggers>${trigger}</Triggers>
  <Actions Context="Author"><Exec>
    <Command>wscript.exe</Command>
    <Arguments>${esc(`"${join(ROOT, "scripts", "hidden.vbs")}" ${t.job}`)}</Arguments>
    <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
  </Exec></Actions>
</Task>`;
}

const schtasks = (...args) => spawnSync("schtasks", args, { encoding: "utf8", windowsHide: true });
const [cmd, flag] = process.argv.slice(2);

if (process.platform !== "win32") {
  console.log("Task Scheduler is Windows-only. Add these lines to your crontab (crontab -e):\n");
  for (const t of TASKS.filter((x) => x.cron)) console.log(`${t.cron.padEnd(16)} cd "${ROOT}" && ${t.cmd} >> logs/${t.log}.log 2>&1`);
  console.log("\n(cc, the desktop companion, needs Windows.)");
  process.exit(0);
}
if (flag === "--list" || !["install", "uninstall"].includes(cmd)) {
  for (const t of TASKS) console.log(`${name(t).padEnd(20)} ${t.about}`);
  if (!["install", "uninstall"].includes(cmd)) console.log("\nusage: node scripts/tasks.mjs install|uninstall [--list]");
  process.exit(0);
}

let failed = 0;
if (cmd === "install") {
  const dir = mkdtempSync(join(tmpdir(), "cc-studio-tasks-"));
  for (const t of TASKS) {
    const file = join(dir, `${t.job}.xml`);
    writeFileSync(file, Buffer.from("﻿" + xml(t), "utf16le"));
    const r = schtasks("/create", "/tn", name(t), "/xml", file, "/f");
    if (r.status === 0) console.log(`registered  ${name(t)}`);
    else { failed++; console.log(`FAILED      ${name(t)}: ${(r.stderr || r.stdout).trim()}`); }
  }
  rmSync(dir, { recursive: true, force: true });
  // The logon jobs start now too, so you don't have to log out and in.
  for (const t of TASKS.filter((x) => x.logon)) schtasks("/run", "/tn", name(t));
  console.log(failed ? `\n${failed} task(s) failed.` : "\nAll tasks registered; the bot, the desk and cc are starting. Pause everything any time with \"pause\" in cc or Telegram.");
} else {
  for (const t of TASKS) {
    schtasks("/end", "/tn", name(t));
    const r = schtasks("/delete", "/tn", name(t), "/f");
    console.log(r.status === 0 ? `removed     ${name(t)}` : `not there   ${name(t)}`);
  }
}
process.exit(failed ? 1 : 0);
