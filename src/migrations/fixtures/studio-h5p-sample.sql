-- Test fixture for importStudioContent.ts. NOT a migration.
--
-- A slice of Studio's H5P tables covering the cases the importer has to get
-- right: a library with dependencies, a restricted library, content whose
-- parameters are malformed, and content pointing at a library that is gone.
--
--   docker run -d --name h5p-mysql -e MYSQL_ROOT_PASSWORD=test \
--     -e MYSQL_DATABASE=studio_main -p 33064:3306 mysql:8.0
--   docker exec -i h5p-mysql mysql -uroot -ptest studio_main \
--     < src/migrations/fixtures/studio-h5p-sample.sql

CREATE TABLE h5p_libraries (
  library_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  machine_name VARCHAR(127) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  major_version INT UNSIGNED NOT NULL,
  minor_version INT UNSIGNED NOT NULL,
  patch_version INT UNSIGNED NOT NULL,
  runnable TINYINT UNSIGNED NOT NULL DEFAULT 1,
  fullscreen TINYINT UNSIGNED NOT NULL DEFAULT 0,
  embed_types VARCHAR(255) NOT NULL DEFAULT '',
  preloaded_js TEXT, preloaded_css TEXT, drop_library_css TEXT,
  semantics TEXT NOT NULL, restricted TINYINT UNSIGNED NOT NULL DEFAULT 0,
  tutorial_url VARCHAR(1000), has_icon TINYINT UNSIGNED NOT NULL DEFAULT 0,
  add_to TEXT, metadata_settings TEXT
);

CREATE TABLE h5p_libraries_libraries (
  library_id INT UNSIGNED NOT NULL,
  required_library_id INT UNSIGNED NOT NULL,
  dependency_type VARCHAR(31) NOT NULL,
  PRIMARY KEY (library_id, required_library_id)
);

CREATE TABLE h5p_content (
  id INT UNSIGNED NOT NULL PRIMARY KEY,
  library_id INT UNSIGNED NOT NULL,
  parameters LONGTEXT, filtered_parameters LONGTEXT,
  disabled_features SMALLINT UNSIGNED DEFAULT 0,
  title VARCHAR(255), a11y_title VARCHAR(255), authors LONGTEXT,
  source VARCHAR(2083), year_from INT UNSIGNED, year_to INT UNSIGNED,
  license VARCHAR(32), license_version VARCHAR(10), changes LONGTEXT,
  license_extras LONGTEXT, author_comments LONGTEXT, default_language VARCHAR(32)
);

CREATE TABLE h5p_content_libraries (
  content_id INT UNSIGNED NOT NULL,
  library_id INT UNSIGNED NOT NULL,
  dependency_type VARCHAR(31) NOT NULL DEFAULT 'preloaded',
  drop_css TINYINT UNSIGNED NOT NULL DEFAULT 0,
  weight INT UNSIGNED NOT NULL DEFAULT 999999,
  PRIMARY KEY (content_id, library_id, dependency_type)
);

-- Library 1 depends on 3 (preloaded) and 4 (editor). Library 2 is restricted.
INSERT INTO h5p_libraries
 (library_id,machine_name,title,major_version,minor_version,patch_version,runnable,fullscreen,embed_types,preloaded_js,preloaded_css,drop_library_css,semantics,restricted,metadata_settings) VALUES
 (1,'H5P.MultiChoice','Multiple Choice',1,16,0,1,0,'iframe','js/multichoice.js, js/helper.js','css/multichoice.css','','[]',0,'{"disable":0,"disableExtraTitleField":0}'),
 (2,'H5P.Column','Page',1,18,0,0,0,'div','js/column.js','css/column.css','H5P.Blanks','[]',1,NULL),
 (3,'H5P.Question','Question',1,5,0,0,0,'','js/question.js','css/question.css','','[]',0,NULL),
 (4,'H5PEditor.VerticalTabs','Vertical Tabs',1,3,0,0,0,'','js/tabs.js',NULL,'','[]',0,NULL);

INSERT INTO h5p_libraries_libraries (library_id, required_library_id, dependency_type) VALUES
 (1,3,'preloaded'),
 (1,4,'editor');

-- 31483 is the highest id, so the counter must land there.
-- 777 has malformed parameters. 888 points at a library that no longer exists.
INSERT INTO h5p_content
 (id,library_id,parameters,title,a11y_title,authors,source,year_from,year_to,license,license_version,changes,license_extras,author_comments,default_language) VALUES
 (101,1,'{"question":"Which organelle performs photosynthesis?","answers":[{"text":"Chloroplast","correct":true}]}','Photosynthesis Quiz','Photosynthesis Quiz (accessible)','[{"name":"A. Author","role":"Author"}]','https://example.edu/source',2019,2021,'CC BY','4.0','[]','Extra terms here','Internal note','en'),
 (31483,2,'{"content":[{"library":"H5P.Text 1.1"}]}','Cell Biology Page',NULL,NULL,NULL,NULL,NULL,'PDM',NULL,NULL,NULL,NULL,'en'),
 (777,1,'{not valid json','Broken Parameters',NULL,NULL,NULL,NULL,NULL,'CC BY','4.0',NULL,NULL,NULL,'en'),
 (888,99,'{"ok":true}','Missing Library',NULL,NULL,NULL,NULL,NULL,'CC BY','4.0',NULL,NULL,NULL,'en');

-- The author of 101 switched off Download (2) and Embed (4) in Studio, so its
-- embed must show the action bar without those two buttons. 31483 keeps the
-- default 0 and shows everything.
UPDATE h5p_content SET disabled_features = 6 WHERE id = 101;

INSERT INTO h5p_content_libraries (content_id, library_id, dependency_type, drop_css, weight) VALUES
 (101,1,'preloaded',0,1),
 (101,3,'preloaded',0,2),
 (31483,2,'preloaded',0,1);
