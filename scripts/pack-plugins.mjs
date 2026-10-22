import { cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url))),names=['sessionbridge-do','session-bridge-delegate','session-bridge-supervise','session-bridge-return'],hash=data=>createHash('sha256').update(data).digest('hex'),receipts=[];
for(const harness of ['codex','claude','pi','hermes','dsh']){
 const plugin=join(root,'plugins',harness);cpSync(join(root,'plugins/common/locate.mjs'),join(plugin,'locate.mjs'));
 const skills=join(plugin,'skills');if(existsSync(skills))rmSync(skills,{recursive:true});mkdirSync(skills,{recursive:true});
 for(const name of names){const source=join(root,'skills',name);cpSync(source,join(skills,name),{recursive:true});for(const file of readdirSync(source)){if(file!=='SKILL.md')continue;const sha=hash(readFileSync(join(source,file)));if(sha!==hash(readFileSync(join(skills,name,file))))throw new Error('Skill digest differs');receipts.push({harness,skill:name,sha256:sha});}}
 if(harness==='pi'){const path=join(plugin,'package.json'),value=JSON.parse(readFileSync(path,'utf8'));value.pi.skills=['./skills'];writeFileSync(path,JSON.stringify(value,null,2)+'\n');}
}
mkdirSync(join(root,'docs/distribution'),{recursive:true});writeFileSync(join(root,'docs/distribution/skill-digests.json'),JSON.stringify(receipts,null,2)+'\n');
console.error(JSON.stringify({state:'packed',plugins:5,canonical_skills:names.length,digest_checks:receipts.length}));
