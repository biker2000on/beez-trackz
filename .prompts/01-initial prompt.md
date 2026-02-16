Self-hosted Hive Tracks to manage bee notes and honey sales / management. This will not be a public for external use app but for the use of the self-hosted entity / user. 

I want this app to be AI first: 
* record notes via audio notes or video notes and transcribe and insert to the database appropriately for each hive
* AI powered recommendations, that are not enforced and can be controlled outputs based on configuration parameters for how often you like to inspect, etc.
* powered by my claude Max subscription, with the option to plug in other models like my Gemini Pro subscription later. Also capability for API key usage. 
* AI powered hive history
* Upload of old hive records in audio, video, markdown files, etc and creation and maintenance of records accordingly.

Things to track:
* Apiaries
  * hives in apiary
    * Track inspections
      * queen health
      * stores
      * brood
      * illnesses (ie small hive beetles or varroa)
      * Treatments applied
  * layout of apiary
    * this should be a canvas that we can draw the layout and label where each hive will be located. One naming convention for hives will be their location, ie A3 or D4. I want to be able to label which direction is north and the possible option to overlay the canvas on a map to show true location. Probably need satellite view to be able to do this. 
* Track geaneology of hive. ie where the queen came from prior to that hive, if it was started from a queen cell from another hive raised queen etc. This data will not always be available if I catch a swarm for instance. 
* Track age of queens and also provide the standard color code for queens. 
* When moving hives between locations, track where it used to be, but add new notes to the hive via location A3, B2, etc...
* Equipment on each hive. ie number of each type of box. I don't track each box specifically, but I want to know I have 1 or 2 deeps, and when I added each honey super, double screen board, queen excluder etc.
  * visualize this stack in a VR style visualization of current status and be able to forward and reverse it in time according to the records. 
  * Also, manage the amount of equipment I have in total, so equipment and storage location of excess equipment. I do not want the overzealous implementation fo a full inventory management system used in enterprise. 
    * Recommendation engine to determine if I have enough equipment for the upcoming season. 
* Honey harvest tracking
  * how much honey from each hive
    * I weigh each honey super before and after harvest to determine honey in the super
  * total honey harvested
  * Total honey jarred
  * inventory / sales management for honey. Also do not need nor want the overzealous implementation of enterprise. 

All data likely stored in postgres. 

Tech stack TBD. Please recommend options. 