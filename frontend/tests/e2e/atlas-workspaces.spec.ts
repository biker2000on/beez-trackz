import { test, expect } from "@playwright/test";
for (const queued of [false,true]) {
 test(`Sales quick action reports ${queued ? "queued payment" : "fulfillment failure"}`,async({page})=>{
  await page.route("**/api/v1/**",async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith("/auth/status"))return route.fulfill({json:{authenticated:true,setupComplete:true}});
   if(path.endsWith("/access/me"))return route.fulfill({json:{id:"u",displayName:"Test",isAdmin:true,memberships:[]}});
   if(path.endsWith("/payment")||path.endsWith("/fulfill"))return route.fulfill({status:queued?202:409,json:queued?{queued:true,offline:true,mutationId:"queued-sale"}:{error:"Insufficient stock for this order"}});
   if(path.endsWith("/sales"))return route.fulfill({json:[{id:"sale-1",date:"2026-09-11",orderNumber:"ORDER-1",orderStatus:"pending",channel:"direct",paymentMethod:"cash",amountPaid:0,totalAmount:10,lineItems:[],physicalAppliedAt:null}]});
   if(path.endsWith("/workbench"))return route.fulfill({json:{asOf:"2026-09-11T12:00:00Z",freshness:{origin:"server",stale:false},drafts:[],consignment:[],sellable:[]}});
   return route.fulfill({json:[]});
  });
  await page.goto("/sales");
  await page.getByRole("button",{name:queued?"Mark order paid":"Mark order fulfilled",exact:true}).click();
  await expect(page.getByText(queued?"Saved offline — will sync when you reconnect":"Insufficient stock for this order",{exact:true})).toBeVisible();
  await expect(page.getByText("Order updated",{exact:true})).toHaveCount(0);
 });
}
for (const width of [320,390,768]) {
 test(`Stock named pages and full record survive history at ${width}px`, async ({page})=>{
  await page.setViewportSize({width,height:844});
  await page.route("**/api/v1/**", async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith("/auth/status"))return route.fulfill({json:{authenticated:true,setupComplete:true}});
   if(path.endsWith("/access/me"))return route.fulfill({json:{id:"u",displayName:"Test",isAdmin:true,memberships:[]}});
   if(path.includes("/stock"))return route.fulfill({json:{asOf:"2026-09-11T12:00:00Z",freshness:{origin:"server",stale:false},rows:[{itemId:"item-1",itemName:"Medium super",kind:"equipment",unit:"each",locationId:"home",locationName:"Home",lotId:null,lotCode:null,condition:"serviceable",hiveId:null,onHand:"12",reserved:"2",available:"10",countKnown:true,originKnown:false,holds:[],holdsKnown:true}],history:[]}});
   return route.fulfill({json:[]});
  });
  await page.goto("/stock/equipment");
  await expect(page.getByRole("heading",{name:"Equipment",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Medium super",exact:true}).click();
  await expect(page).toHaveURL(/stock\/items\/item-1/);
  await expect(page.getByRole("heading",{name:"Movement history"})).toBeVisible();
  await page.goBack();await expect(page).toHaveURL(/stock\/equipment/);
  await page.goForward();await page.reload();await expect(page.getByRole("heading",{name:"Medium super",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.getByRole("button",{name:"Pages",exact:true}).click();
  const sheet=page.getByRole("dialog");
  for(const name of ["Equipment","Bulk honey","Packaging","Finished goods","Market day","Customers & wholesale","Harvest history","Lots & labels"]) await expect(sheet.getByRole("link",{name,exact:true})).toBeVisible();
 });
}
