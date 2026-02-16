## Issues and improvements

1. There was a regression in the canvas rendering. The hives are no longer rendered on the canvas. I also need to be able to click and drag hives from one spot to another on the canvas as well as on top of one another where they will become double stacked. 
2. I need to be able to track splits, ie which hive is the parent hive and what not. 
3. I need full crud on all types exposed on the UI. Most items don't have delete exposed. 
4. Hives need to have the ability to archive them to hide from the UI, with the ability to unhide when needed. 
5. Hives also need the ability to mark it as a deadout and archive it. 
6. Inspection records need to have the ability to delete. 
7. On apiary bulk actions, clicking the all selector submits the form. That is not correct. Should submit on button press at the bottom. 
8. When adding or editing hives, I don't need a name, I want it to be a location. Can provide a list of locations from the layout. Have checkboxes for top/bottom/left/right that are by default blank. Hives can be edited from the hive form or from the layout. 
9. Edit hive from the layout in a modal. 
10. Queens > Add Queen button goes to a page with the following runtime error: A <Select.Item /> must have a value prop that is not an empty string. This is because the Select value can be set to an empty string to clear the selection and show the placeholder.
11. hives page should have selector for card or table view. Need to add a table view of hives. 
12. Preferences page is a 404. 
13. Equipment page, should show sums of each type of equipment, I don't need to track each one separately. Need the ability to adjust stock of equipemnt as I buy or throw away equipment. And also need the ability to move equipment to the field on a hive. Add equipment from the hive page should decrement stock I have of it. 