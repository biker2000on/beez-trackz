## Issues and Fixes

Most of the fixes are related to the canvas view and functionality:

1. When a hive is stacked another hive it splits them correctly. When one is moved to another stand, they should both expand back to full size instead of staying as half size. 
2. I need to be able to right click on a hive in the canvas and get a context menu for the following: 
   1. flip the direction arrow. 
   2. edit hive (this opens a modal to edit the hive)
   3. split hive
3. I need to be able to right click and rotate the North arrow. 
4. Right click on a slot on a stand should give me an option to add a hive there. 
5. Hive names / locations should be updated on move when the location is updated via the canvas, with location tracking visible on the hive detail page. 
6. Dropping one hive on top of another, should give the option for top/bottom split or right/left split for nucs. 

## Other items
6. On the hive detail page, the edit hive form should be a modal and not a new page. Also give the option to truly delete the hive instead of just archive it. 
7. Same for equipment add. It should be a modal. It should also look up available equipment from inventory to add. Not just give default stuff to add new. 
8. Apiaries page should show the number of active hives, not total number. It should filter out archived / dead out hives. 
9.  queen geneaology canvas controls in dark mode are light on light. Please fix. 
10. Create an MCP Server for bee trackz so I can wire up claude to talk to it directly and enter all the data to it. This will allow me to use my subscription with claude. 
11. Update to equipment inventory to have stock vs individual broke the frame calculator. Need to be able to record number of frames per box and then have a frame category to count total number of frames in stock. I would like for the frame stock to be able to record whether the frames are drawn or fresh. 
