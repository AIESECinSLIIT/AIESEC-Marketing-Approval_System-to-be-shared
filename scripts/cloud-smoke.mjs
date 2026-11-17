// Explicit opt-in smoke test for a newly deployed, empty project.
// Fixture accounts are temporary and must be removed after verification.
import {createClient} from '@supabase/supabase-js';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const url=process.env.VITE_SUPABASE_URL, key=process.env.VITE_SUPABASE_ANON_KEY;
const client=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const check=r=>{if(r.error)throw r.error;return r.data};
const [action, fixture]=process.argv.slice(2);
if(action==='signup') {
 const suffix=randomBytes(5).toString('hex'), password=randomBytes(20).toString('base64url');
 const users=[];
 for(const role of ['creator','marketing','b2c']) {
  const email=`approval-qa-${suffix}-${role}@example.com`;
  const c=client();const data=check(await c.auth.signUp({email,password,options:{data:{name:'Temporary workflow check'}}}));
  assert.ok(data.session,'Signup must produce a session without requiring email confirmation');
  users.push({id:data.user.id,email,role});await c.auth.signOut();
 }
 console.log(JSON.stringify({users,password}));
} else if(action==='workflow') {
 const {users,password}=JSON.parse(fixture);
 const clients=await Promise.all(users.map(async u=>{const c=client();check(await c.auth.signInWithPassword({email:u.email,password}));return c}));
 const [creator,marketing,b2c]=clients;
 assert.equal(check(await creator.rpc('club_me')).role,'CREATOR');
 assert.ok((await creator.rpc('club_users')).error,'Creators must not list accounts');
 const path=`${users[0].id}/${randomBytes(8).toString('hex')}/check.png`;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64');
 check(await creator.storage.from('creatives').upload(path,png,{contentType:'image/png'}));
 const data={title:'Temporary workflow check',event:'QA',category:'MARKETING',contentType:'Social post',platform:'Instagram',caption:'Temporary test',notes:'',status:'PENDING'};
 const saved=check(await creator.rpc('club_save',{p_id:null,p_data:data,p_files:[{path,name:'check.png',mime:'image/png'}]})).submission;
 assert.ok(check(await marketing.rpc('club_submissions')).submissions.some(s=>s.id===saved.id));
 assert.ok(!check(await b2c.rpc('club_submissions')).submissions.some(s=>s.id===saved.id));
 assert.ok((await b2c.rpc('club_detail',{p_id:saved.id})).error);
 assert.ok((await creator.rpc('club_review',{p_id:saved.id,p_decision:'APPROVED',p_comment:'',p_version:1})).error);
 assert.ok((await marketing.rpc('club_review',{p_id:saved.id,p_decision:'REJECTED',p_comment:'',p_version:1})).error);
 check(await marketing.rpc('club_review',{p_id:saved.id,p_decision:'CHANGES_REQUESTED',p_comment:'Change the logo',p_version:1}));
 check(await creator.rpc('club_save',{p_id:saved.id,p_data:{...data,version:2},p_files:[]}));
 check(await marketing.rpc('club_review',{p_id:saved.id,p_decision:'APPROVED',p_comment:'',p_version:3}));
 assert.ok((await marketing.rpc('club_review',{p_id:saved.id,p_decision:'REJECTED',p_comment:'Stale',p_version:3})).error);
 const detail=check(await creator.rpc('club_detail',{p_id:saved.id}));
 assert.equal(detail.submission.status,'APPROVED');assert.equal(detail.revisions.length,2);
 const signed=check(await marketing.storage.from('creatives').createSignedUrl(path,60));
 assert.equal((await fetch(signed.signedUrl)).status,200);
 assert.ok((await b2c.storage.from('creatives').createSignedUrl(path,60)).error);
 const denied=await creator.functions.invoke('manage-users',{body:{action:'create'}});
 assert.ok(denied.error,'Creator must not invoke account administration');
 console.log(JSON.stringify({ok:true,submissionId:saved.id,path,checks:14}));
 for(const c of clients)await c.auth.signOut();
} else if(action==='cleanup-storage') {
 const {users,password,path}=JSON.parse(fixture),c=client();
 check(await c.auth.signInWithPassword({email:users[0].email,password}));
 check(await c.storage.from('creatives').remove([path]));await c.auth.signOut();console.log('Temporary creative removed.');
} else throw new Error('Use signup, workflow, or cleanup-storage.');
