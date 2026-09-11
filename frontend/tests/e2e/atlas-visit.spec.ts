import { test, expect, type Page } from "@playwright/test";
async function mockVisit(page:Page, queued=false) {
 const submitted: Record<string,unknown>[]=[];
 await page.route("**/api/v1/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith("/auth/status"))return route.fulfill({json:{authenticated:true,setupComplete:true}});
  if(path.endsWith("/access/me"))return route.fulfill({json:{id:"user-visit",isAdmin:true,displayName:"Visit test",memberships:[]}});
  if(path.endsWith("/stock"))return route.fulfill({json:{rows:[]}});
  if(path.endsWith("/apiaries"))return route.fulfill({json:[{id:"a1",name:"North yard"}]});
  if(path.endsWith("/hives"))return route.fulfill({json:[{id:"h1",apiaryId:"a1",positionLabel:"Hive 1",status:"active",isArchived:false},{id:"h2",apiaryId:"a1",positionLabel:"Hive 2",status:"active",isArchived:false}]});
  if(path.endsWith("/inspection-visits")) {submitted.push(route.request().postDataJSON());return route.fulfill({status:queued?202:200,json:queued?{queued:true,offline:true,mutationId:"queued-1"}:{success:true,outcomes:[{itemKey:"item-1",status:"saved",inspectionIds:["inspection-1"],operationIds:[]}]}});}
  return route.fulfill({json:[]});
 });return submitted;
}
test("Manual hive inspection preserves unknown queen through reload and saves at 320px",async({page})=>{
 await page.setViewportSize({width:320,height:844});const submitted=await mockVisit(page);
 await page.goto("/yard/apiaries/a1/visit?hive=h1");await page.getByRole("button",{name:"Type instead"}).click();
 await page.getByLabel("Notes",{exact:true}).fill("Brood looks good");
 await expect(page.getByLabel("Queen observation",{exact:true})).toContainText("Not mentioned / not checked");
 await page.reload();await page.getByRole("button",{name:"Open draft",exact:true}).click();
 await expect(page.getByLabel("Notes",{exact:true})).toHaveValue("Brood looks good");
 await page.getByRole("button",{name:"Confirm inspection",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Saved to Hive 1"})).toBeVisible();
 expect(submitted).toHaveLength(1);expect((submitted[0].inspection as {queenSeen:unknown}).queenSeen).toBeNull();
 expect(submitted[0].hiveId).toBe("h1");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test("Queued manual observation is not a saved server receipt",async({page})=>{
 await mockVisit(page,true);await page.goto("/yard/apiaries/a1/visit");await page.getByRole("button",{name:"Type instead"}).click();
 await page.getByLabel("Apiary notes").fill("Water source is dry");await page.getByRole("button",{name:"Confirm inspection",exact:true}).click();
 await expect(page.getByText("Queued on this device. Waiting for a server receipt.")).toBeVisible();
 await expect(page.getByRole("heading",{name:/Saved to/})).toHaveCount(0);
 await page.reload();await page.getByRole("button",{name:"Open draft",exact:true}).click();await expect(page.getByRole("button",{name:"Check / retry confirmation"})).toBeVisible();
});
test("Uploaded walkthrough keeps failed hive pending while preserving saved hive receipt",async({page})=>{
 await mockVisit(page);let attempts=0;
 await page.route("**/api/v1/transcriptions/media-1/confirm",async route=>{attempts++;const payload=route.request().postDataJSON();const item=payload.inspections[0];return route.fulfill({json:attempts===1?{success:true,outcomes:[{itemKey:item.itemKey,status:"saved",inspectionIds:["i1"]}]}:{success:false,outcomes:[{itemKey:item.itemKey,status:"failed",error:"Equipment stock is unavailable"}]}});});
 await page.goto("/yard/apiaries/a1/visit?scope=batch");
 await page.evaluate(async()=>{await new Promise<void>((resolve,reject)=>{const open=indexedDB.open("atlas-voice-captures",1);open.onupgradeneeded=()=>open.result.createObjectStore("captures",{keyPath:["userId","captureId"]});open.onerror=()=>reject(open.error);open.onsuccess=()=>{const tx=open.result.transaction("captures","readwrite");tx.objectStore("captures").put({userId:"user-visit",captureId:"capture-batch",ownerType:"apiary",ownerId:"a1",mode:"batch",observedAt:"2026-09-11T10:00:00Z",updatedAt:"2026-09-11T10:00:00Z",timeZone:"America/New_York",state:"review",mediaFileId:"media-1",versionId:"version-1",drafts:[{itemKey:"hive-1",scope:"hive",hiveId:"h1",fields:{queenSeen:null,notes:"First hive"}},{itemKey:"hive-2",scope:"hive",hiveId:"h2",fields:{queenSeen:true,notes:"Second hive"}}]});tx.oncomplete=()=>{open.result.close();resolve();};};});});
 await page.reload();await page.getByRole("button",{name:"Open draft",exact:true}).click();
 await page.getByRole("button",{name:"Confirm inspection",exact:true}).first().click();await expect(page.getByRole("heading",{name:"Saved to Hive 1"})).toBeVisible();
 await page.getByRole("button",{name:"Confirm inspection",exact:true}).click();await expect(page.getByRole("alert").filter({hasText:"Equipment stock is unavailable"})).toBeVisible();
 await expect(page.getByRole("heading",{name:"Saved to Hive 1"})).toBeVisible();await expect(page.getByRole("heading",{name:"Saved to Hive 2"})).toHaveCount(0);
 await page.reload();await page.getByRole("button",{name:"Open draft",exact:true}).click();await expect(page.getByRole("heading",{name:"Saved to Hive 1"})).toBeVisible();expect(attempts).toBe(2);
});

test("Stopping microphone persists audio before upload and carries capture context into confirmation",async({page})=>{
 await mockVisit(page);let uploadBody="";let audioDurable=false;let confirmed=false;
 await page.addInitScript(()=>{
  class Recorder {state="inactive";mimeType="audio/webm";ondataavailable:((e:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;static isTypeSupported(){return true;}start(){this.state="recording";}stop(){this.state="inactive";this.ondataavailable?.({data:new Blob(["audio-fixture"],{type:"audio/webm"})});this.onstop?.();}}
  Object.defineProperty(window,"MediaRecorder",{value:Recorder});Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>({getTracks:()=>[{stop(){}}]})});
 });
 await page.route("**/api/v1/transcriptions",async route=>{
  uploadBody=route.request().postDataBuffer()?.toString()??"";
  audioDurable=await page.evaluate(()=>new Promise<boolean>((resolve,reject)=>{const open=indexedDB.open("atlas-voice-captures",1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const read=open.result.transaction("captures","readonly").objectStore("captures").getAll();read.onsuccess=()=>{resolve(read.result.some((r:{audio?:Blob})=>r.audio instanceof Blob&&r.audio.size>0));open.result.close();};};}));
  await route.fulfill({json:{mediaFileId:"uploaded-audio"}});
 });
 await page.route("**/api/v1/transcriptions/uploaded-audio?*",route=>route.fulfill({json:{id:"uploaded-audio",status:"complete",currentVersionId:"version-audio",transcriptionText:"The water is dry",parsed:{inspections:[{itemKey:"apiary-item",scope:"apiary",notes:"The water is dry"}]}}}));
 await page.route("**/api/v1/transcriptions/uploaded-audio/confirm",route=>{confirmed=true;return route.fulfill({json:{success:true,outcomes:[{itemKey:"apiary-item",status:"saved",apiaryInspectionIds:["a-inspection"]}]}});});
 await page.goto("/yard/apiaries/a1/visit");await page.getByRole("button",{name:"Record apiary",exact:true}).click();await page.getByRole("button",{name:"Stop & review"}).click();
 await expect(page.getByLabel("Apiary notes")).toHaveValue("The water is dry");expect(audioDurable).toBe(true);
 for(const field of ["captureId","observedAt","timeZone","mode","ownerId"])expect(uploadBody).toContain(`name="${field}"`);
 expect(uploadBody).toContain("apiary");expect(uploadBody).toContain("a1");expect(confirmed).toBe(false);
 await page.getByRole("button",{name:"Confirm inspection",exact:true}).click();await expect(page.getByRole("heading",{name:"Saved to apiary history"})).toBeVisible();expect(confirmed).toBe(true);
});
async function seedCapture(page:Page, record:Record<string,unknown>, audio=false) {
 await page.evaluate(async({record,audio})=>new Promise<void>((resolve,reject)=>{const open=indexedDB.open("atlas-voice-captures",1);open.onupgradeneeded=()=>open.result.createObjectStore("captures",{keyPath:["userId","captureId"]});open.onerror=()=>reject(open.error);open.onsuccess=()=>{const tx=open.result.transaction("captures","readwrite");tx.objectStore("captures").put({...record,...(audio?{audio:new Blob(["recoverable-audio"],{type:"audio/webm"})}:{})});tx.oncomplete=()=>{open.result.close();resolve();};};}),{record,audio});
}
const recoveryCapture={userId:"user-visit",captureId:"recovery-1",ownerType:"apiary",ownerId:"a1",mode:"apiary",observedAt:"2026-09-11T10:00:00Z",updatedAt:"2026-09-11T10:00:00Z",timeZone:"America/New_York",state:"review"};
test("Replacement recording preserves the original observation envelope", async ({page}) => {
 await mockVisit(page);
 await page.addInitScript(() => {
  class Recorder {state="inactive";mimeType="audio/webm";ondataavailable:((e:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;static isTypeSupported(){return true;}start(){this.state="recording";}stop(){this.state="inactive";this.ondataavailable?.({data:new Blob(["replacement-audio"],{type:"audio/webm"})});this.onstop?.();}}
  Object.defineProperty(window,"MediaRecorder",{value:Recorder});Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>({getTracks:()=>[{stop(){}}]})});
 });
 let body="";
 await page.route("**/api/v1/transcriptions",route=>{body=route.request().postDataBuffer()?.toString()??"";return route.fulfill({json:{mediaFileId:"replacement-media"}});});
 await page.route("**/api/v1/transcriptions/replacement-media?*",route=>route.fulfill({json:{id:"replacement-media",status:"failed",error:"Test transcription failure"}}));
 await page.goto("/yard/apiaries/a1/visit?hive=h1");
 await seedCapture(page,{...recoveryCapture,ownerType:"hive",ownerId:"h1",mode:"single",mediaFileId:"original-media",uploadAttempted:true,timeZone:"Pacific/Auckland"},true);
 await page.reload();await page.getByRole("button",{name:"Open draft",exact:true}).click();
 await page.getByRole("button",{name:"Record a replacement — keep original",exact:true}).click();
 await page.getByRole("button",{name:"Stop & review"}).click();
 await expect.poll(()=>body).toContain("original-media");
 for(const value of [recoveryCapture.observedAt,"Pacific/Auckland","single","h1"])expect(body).toContain(value);
 const captures=await page.evaluate(()=>new Promise<Record<string,unknown>[]>((resolve,reject)=>{const open=indexedDB.open("atlas-voice-captures",1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const read=open.result.transaction("captures","readonly").objectStore("captures").getAll();read.onsuccess=()=>{resolve(read.result);open.result.close();};};}));
 expect(captures).toHaveLength(2);
 const replacement=captures.find(c=>c.replacesMediaFileId==="original-media")!;
 expect(replacement.captureId).not.toBe(recoveryCapture.captureId);
 expect(replacement).toMatchObject({ownerType:"hive",ownerId:"h1",mode:"single",observedAt:recoveryCapture.observedAt,timeZone:"Pacific/Auckland"});
});
for (const mode of ["single", "apiary", "batch"] as const) {
 test(`Android recording upload preserves file, time and ${mode} scope without microphone access`,async({page})=>{
  await page.setViewportSize({width:390,height:844});await mockVisit(page);
  await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:()=>{throw new Error("Microphone must not be requested for a file upload");}});});
  let body="";let uploads=0;
  await page.route("**/api/v1/transcriptions",route=>{uploads++;body=route.request().postDataBuffer()?.toString()??"";return route.fulfill({json:{mediaFileId:"android-upload"}});});
  await page.route("**/api/v1/transcriptions/android-upload?*",route=>route.fulfill({json:{id:"android-upload",status:"complete",currentVersionId:"v1",parsed:{inspections:[{itemKey:"file-item",scope:mode==="apiary"?"apiary":"hive",matchedHiveId:mode==="apiary"?null:"h1",notes:"Recorder file observation",queenSeen:null}]}}}));
  await page.route("**/api/v1/transcriptions/android-upload/confirm",route=>route.fulfill({json:{success:true,outcomes:[{itemKey:"file-item",status:"saved"}]}}));
  await page.goto(`/yard/apiaries/a1/visit${mode==="single"?"?hive=h1":mode==="batch"?"?scope=batch":""}`);
  const picker=page.waitForEvent("filechooser");await page.getByRole("button",{name:"Upload recording",exact:true}).click();
  await (await picker).setFiles({name:"Orchard inspection.m4a",mimeType:"",buffer:Buffer.from("android-m4a-fixture")});
  await expect(page.getByText("Orchard inspection.m4a",{exact:true})).toBeVisible();
  await page.getByLabel(/Observed at/).fill("2026-09-10T09:15");
  await page.reload();await expect(page.getByLabel(/Observed at/)).toHaveValue("2026-09-10T09:15");
  await expect(page.getByText("Orchard inspection.m4a",{exact:true})).toBeVisible();expect(uploads).toBe(0);
  // Reconnection must not submit the file before the operator has checked its time.
  await page.evaluate(()=>window.dispatchEvent(new Event("online")));expect(uploads).toBe(0);
  await page.getByRole("button",{name:"Upload & review",exact:true}).click();
  await expect(page.getByRole("textbox",{name:mode==="apiary"?"Apiary notes":"Notes",exact:true})).toHaveValue("Recorder file observation");
  expect(uploads).toBe(1);expect(body).toContain('filename="Orchard inspection.m4a"');expect(body).toContain("Content-Type: audio/mp4");expect(body).toContain("2026-09-10T");
  expect(body).toMatch(new RegExp(`name="mode"\\r\\n\\r\\n${mode}\\r\\n`));expect(body).toContain(mode==="single"?"h1":"a1");
  await expect(page.getByRole("link",{name:"Download original recording"})).toHaveAttribute("download","Orchard inspection.m4a");
  await page.getByRole("button",{name:"Confirm inspection",exact:true}).click();await expect(page.getByRole("heading",{name:mode==="apiary"?"Saved to apiary history":"Saved to Hive 1"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 });
}
test("Invalid audio selection can be corrected without creating an empty capture",async({page})=>{
 await mockVisit(page);await page.goto("/yard/apiaries/a1/visit");
 const input=page.getByLabel("Choose recorded audio file");
 await input.setInputFiles({name:"empty.m4a",mimeType:"audio/mp4",buffer:Buffer.from("")});await expect(page.getByRole("alert").filter({hasText:"recording is empty"})).toBeVisible();
 await input.setInputFiles({name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("notes")});await expect(page.getByRole("alert").filter({hasText:"Choose an M4A"})).toBeVisible();
 await expect(page.getByRole("button",{name:"Upload recording",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Upload & review",exact:true})).toHaveCount(0);
});
test("A capture bookmark cannot restore observations in another apiary",async({page})=>{
 await mockVisit(page);await page.goto("/yard/apiaries/a1/visit");await seedCapture(page,{...recoveryCapture,ownerId:"other-yard",manual:true,drafts:[{itemKey:"item",scope:"apiary",hiveId:"",fields:{notes:"Private other yard note"}}]});
 await page.goto("/yard/apiaries/a1/visit?capture=recovery-1");await expect(page.getByRole("alert").filter({hasText:"belongs to another apiary"})).toBeVisible();await expect(page.getByLabel("Apiary notes")).toHaveCount(0);await expect(page.getByText("Private other yard note")).toHaveCount(0);
});
test("Lost upload response freezes timestamp and replays the same capture after reload",async({page})=>{
 await mockVisit(page);const bodies:string[]=[];
 await page.route("**/api/v1/transcriptions",async route=>{bodies.push(route.request().postDataBuffer()?.toString()??"");if(bodies.length===1)return route.abort("failed");return route.fulfill({json:{mediaFileId:"retry-media"}});});
 await page.route("**/api/v1/transcriptions/retry-media?*",route=>route.fulfill({json:{id:"retry-media",status:"complete",parsed:{inspections:[{itemKey:"item",scope:"apiary",notes:"Water source dry"}]}}}));
 await page.goto("/yard/apiaries/a1/visit");await seedCapture(page,{...recoveryCapture,state:"captured"},true);await page.goto("/yard/apiaries/a1/visit?capture=recovery-1");
 await page.getByRole("button",{name:"Retry upload",exact:true}).click();await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByLabel(/Observed at/)).toBeDisabled();
 await page.reload();await expect(page.getByLabel(/Observed at/)).toBeDisabled();await page.getByRole("button",{name:"Retry upload",exact:true}).click();await expect(page.getByLabel("Apiary notes")).toHaveValue("Water source dry");
 expect(bodies).toHaveLength(2);for(const body of bodies){expect(body).toContain("recovery-1");expect(body).toContain("2026-09-11T10:00:00Z");expect(body).toContain("America/New_York");expect(body).toContain("a1");}
});
test("Server outcomes reconcile a pending receipt using the saved target",async({page})=>{
 await mockVisit(page);let confirms=0;
 await page.route("**/api/v1/transcriptions/reconcile-media?*",route=>route.fulfill({json:{id:"reconcile-media",status:"complete",outcomes:[{itemKey:"pending-item",status:"saved",scope:"hive",hiveId:"h2",inspectionIds:["server-inspection"],operationIds:[]}]}}));
 await page.route("**/api/v1/transcriptions/reconcile-media/confirm",route=>{confirms++;return route.fulfill({json:{success:false}});});
 await page.goto("/yard/apiaries/a1/visit");await seedCapture(page,{...recoveryCapture,mode:"batch",mediaFileId:"reconcile-media",drafts:[{itemKey:"pending-item",scope:"hive",hiveId:"h1",fields:{notes:"Original target unresolved",queenSeen:null},pending:{itemKey:"pending-item",hiveId:"h1"},queued:true}]});await page.goto("/yard/apiaries/a1/visit?capture=recovery-1");
 await expect(page.getByRole("heading",{name:"Saved to Hive 2"})).toBeVisible();await expect(page.getByRole("heading",{name:"Saved to Hive 1"})).toHaveCount(0);expect(confirms).toBe(0);await page.reload();await expect(page.getByRole("heading",{name:"Saved to Hive 2"})).toBeVisible();
});
