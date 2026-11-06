/**
 * Folder sync: folders the user asked SMOI to keep indexed, and the files in them. The desktop
 * app watches the folders and sends changes here; this package records each file's state and
 * maps it to an indexed document. Nothing here reads or writes the user's disk. See
 * docs/adr/0019-folder-sync.md.
 */
package com.smoi.folder;
