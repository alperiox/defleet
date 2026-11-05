import { ensureRepo, seedRepo, listRepos, maintainRepos } from "./git";
import { diskState } from "./disk";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RESERVED_NAMES } from "./hub";
import { openStore } from "./store";

const [cmd, name, ...rest] = process.argv.slice(2);

if(["seed","gc","status"].includes(cmd)){
 const dbPath=process.env.HUB_DB??"./fleet.db",store=openStore(dbPath),data=process.env.HUB_DATA_DIR??join(dirname(dbPath),"data");
 try{
  if(cmd==="seed"){if(!name||!rest[0])throw Error("usage: admin.ts seed <project> <source-checkout>");const seeded=await seedRepo(data,name,rest[0]);store.ensureProject(name,store.defaultWorkspace().id);console.log(JSON.stringify(seeded));}
  else if(cmd==="status")console.log(JSON.stringify({disk:diskState(data,dbPath),repos:await listRepos(data,store)},null,2));
  else {const result=await maintainRepos(data,store,{weekly:process.argv.includes("--weekly")});for(const error of result.errors)store.addMessage({thread:"room",from:"human",text:"Repository integrity failure: "+error});console.log(JSON.stringify(result));if(result.errors.length)process.exit(1);}
  process.exit(0);
 }catch(e){console.error((e as Error).message);process.exit(1);}
}

function flag(key: string): string | undefined {
  const i = rest.indexOf(`--${key}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

if ((cmd === "grant" || cmd === "revoke-grant") && name && rest[0]) {
  const store = openStore(process.env.HUB_DB ?? "./fleet.db");
  const agent = store.listAgents().find((a) => a.name === name);
  if (!agent) { console.error(`no agent named "${name}"`); process.exit(1); }
  if (cmd === "grant") store.grantProject(agent.id, rest[0]); else store.revokeProject(agent.id, rest[0]);
  console.log(`${cmd === "grant" ? "granted" : "revoked"} ${name} -> ${rest[0]}. ${name} now sees: ${store.projectsOf(agent.id).join(", ") || "(nothing)"}`);
  process.exit(0);
}

if (cmd === "human-token") {
  const file = join(dirname(process.env.HUB_DB ?? "./fleet.db"), "human-token");
  if (existsSync(file)) { console.log(readFileSync(file, "utf8").trim()); process.exit(0); }
  console.error(`No saved token at ${file}. The hub was started with HUB_HUMAN_TOKEN set: that value is the token (see the hub's start command or environment).`);
  process.exit(1);
}

if (cmd === "revoke-agent" && name) {
  const store = openStore(process.env.HUB_DB ?? "./fleet.db");
  const done = store.revokeAgent(name);
  console.log(done ? `agent "${name}" revoked; its token no longer works.` : `no active agent named "${name}".`);
  process.exit(done ? 0 : 1);
}

if (cmd === "add-agent" && name && RESERVED_NAMES.includes(name)) { console.error(`"${name}" is reserved (@${name} addresses everyone)`); process.exit(1); }

if (cmd !== "add-agent" || !name || !flag("owner") || !flag("device")) {
  console.error("usage: bun run src/admin.ts human-token   (prints the generated human token)\n       bun run src/admin.ts add-agent <name> --owner <owner> --device <device> [--skills a,b]\n       bun run src/admin.ts revoke-agent <name>\n       bun run src/admin.ts grant|revoke-grant <agent> <project>   (external agents see only granted projects)");
  process.exit(1);
}

const store = openStore(process.env.HUB_DB ?? "./fleet.db");
try {
  const { token } = store.addAgent({
    name, owner: flag("owner")!, device: flag("device")!,
    skills: (flag("skills") ?? "").split(",").filter(Boolean),
  });
  console.log(`agent "${name}" added. Token (shown once):\n${token}`);
} catch (e) {
  console.error(`could not add agent: ${(e as Error).message}`);
  process.exit(1);
}
