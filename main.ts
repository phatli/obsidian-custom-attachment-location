import { App, Editor, MarkdownView, Plugin, PluginSettingTab, Setting, moment, normalizePath, TAbstractFile, FileSystemAdapter, ListedFiles, TFile } from 'obsidian';
import * as Path from 'path';

interface CustomAttachmentLocationSettings {
    attachmentFolderPath: string;
    pastedImageFileName: string;
    dateTimeFormat: string;
    autoRenameFolder: boolean;
    autoRenameFiles: boolean;
}

const DEFAULT_SETTINGS: CustomAttachmentLocationSettings = {
    attachmentFolderPath: 'media/${foldername}/${filename}',
    pastedImageFileName: '${filename}-${date}',
    dateTimeFormat: 'YYYYMMDDHHmmssSSS',
    autoRenameFolder: true,
    autoRenameFiles: false
}

let originalSettings = {
    attachmentFolderPath: ''
};

const blobToArrayBuffer = (blob: Blob) => {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result)
      reader.readAsArrayBuffer(blob)
    })
}


class TemplateString extends String{
    interpolate(params: Object) {
        const names = Object.keys(params);
        const vals = Object.values(params);
        return new Function(...names, `return \`${this}\`;`)(...vals);
    }
}


export default class CustomAttachmentLocation extends Plugin {
    settings: CustomAttachmentLocationSettings;
    useRelativePath: boolean = false;
    adapter: FileSystemAdapter;

    async onload() {
        console.log('loading plugin');

        this.adapter = this.app.vault.adapter as FileSystemAdapter;
        await this.loadSettings();
        this.backupConfigs();

        this.addSettingTab(new CustomAttachmentLocationSettingTab(this.app, this));
        /*
            bind this pointer to handlePaste
            this.registerEvent(this.app.workspace.on('editor-paste', this.handlePaste));
        */
        this.registerEvent(this.app.workspace.on('editor-paste', this.handlePaste.bind(this)));
        this.registerEvent(this.app.workspace.on('editor-drop', this.handleDrop.bind(this)));
        this.registerEvent(this.app.vault.on('rename', this.handleRename.bind(this)));


    }

    onunload() {
        console.log('unloading plugin');
        this.restoreConfigs();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if(this.settings.attachmentFolderPath.startsWith('./'))
            this.useRelativePath = true;
        else
            this.useRelativePath = false;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    backupConfigs(){
        //@ts-ignore
        originalSettings.attachmentFolderPath = this.app.vault.getConfig('attachmentFolderPath');
    }

    restoreConfigs(){
        //@ts-ignore
        this.app.vault.setConfig('attachmentFolderPath', originalSettings.attachmentFolderPath);
    }

    updateAttachmentFolderConfig(path: string)
    {
        //@ts-ignore
        this.app.vault.setConfig('attachmentFolderPath', path);
    }

    getAttachmentFolderPath(mdFileName: string, folderName: string)
    {
        let path = new TemplateString(this.settings.attachmentFolderPath).interpolate({
            filename: mdFileName,
            foldername: folderName,
        });
        return path;
    }

    getAttachmentFolderFullPath(mdFolderPath: string, mdFileName: string)
    {
        let attachmentFolder = '';
        let folderName: string = mdFolderPath.split("/").join("_");

        if(this.useRelativePath)
            attachmentFolder = Path.join(mdFolderPath, this.getAttachmentFolderPath(mdFileName, folderName));
        else
        {
            attachmentFolder = this.getAttachmentFolderPath(mdFileName, folderName);
        }
        return normalizePath(attachmentFolder);
    }

    getPastedImageFileName(mdFileName: string, folderName: string)
    {
        let datetime = moment().format(this.settings.dateTimeFormat);
        let name = new TemplateString(this.settings.pastedImageFileName).interpolate({
            filename: mdFileName,
            date: datetime,
            foldername: folderName,
        });
        return name;
    }


    async handlePaste(event: ClipboardEvent, editor: Editor, view: MarkdownView){
        console.log('Handle Paste');

        let mdFileName = view.file.basename;
        let mdFolderPath: string = Path.dirname(view.file.path);
        let folderName: string = mdFolderPath.split("/").join("_");
        let path = this.getAttachmentFolderPath(mdFileName, folderName);
        let fullPath = this.getAttachmentFolderFullPath(mdFolderPath, mdFileName);

        this.updateAttachmentFolderConfig(path);
        // this.app.vault.setConfig('attachmentFolderPath', `./assets/${filename}`);

        let clipBoardData = event.clipboardData;
        let clipBoardItems = clipBoardData.items;
        if(!clipBoardData.getData('text/plain')){
            for(let i in clipBoardItems){
                if(!clipBoardItems.hasOwnProperty(i))
                    continue;
                let item = clipBoardItems[i];
                if(item.kind !== 'file')
                    continue;
                if(!(item.type === 'image/png' || item.type === 'image/jpeg'))
                    continue;

                let pasteImage = item.getAsFile();
                if(!pasteImage)
                    continue;

                let extension = '';
                item.type === 'image/png' ? extension = 'png' : item.type === 'image/jpeg' && (extension = 'jpeg');

                event.preventDefault();

                //if folder not exist, mkdir first.
                if(!await this.adapter.exists(fullPath))
                    await this.adapter.mkdir(fullPath);

                let img = await blobToArrayBuffer(pasteImage);

                let name = this.getPastedImageFileName(mdFileName, folderName);
                // let name = 'image-' + moment().format('YYYYMMDDHHmmssSSS');


                //@ts-ignore
                let imageFile = await this.app.saveAttachment(name, extension, img);
                let markdownLink = await this.app.fileManager.generateMarkdownLink(imageFile, view.file.path);
                markdownLink += '\n\n';
                editor.replaceSelection(markdownLink);
            }
        }
    }

    async handleDrop(event: DragEvent, editor: Editor, view: MarkdownView){
        console.log('Handle Drop');

        let mdFileName = view.file.basename;
        let mdFolderPath: string = Path.dirname(view.file.path);
        let folderName: string = mdFolderPath.split("/").join("_");
        let path = this.getAttachmentFolderPath(mdFileName, folderName);
        let fullPath = this.getAttachmentFolderFullPath(mdFolderPath, mdFileName);

        if(!this.useRelativePath && !await this.adapter.exists(fullPath))
            await this.app.vault.createFolder(fullPath);
        
        this.updateAttachmentFolderConfig(path);
    }

    async handleRename(newFile: TFile, oldFilePath: string){
        console.log('Handle Rename');

        //if autoRename is off or not a markdown file
        if(!this.settings.autoRenameFolder || newFile.extension !== 'md')
            return;

        let newName = newFile.basename;

        let oldName = Path.basename(oldFilePath, '.md');

        let mdFolderPath: string = Path.dirname(newFile.path);
        let folderName: string = mdFolderPath.split("/").join("_");
        let oldAttachmentFolderPath: string = this.getAttachmentFolderFullPath(mdFolderPath, oldName);
        let newAttachmentFolderPath: string = this.getAttachmentFolderFullPath(mdFolderPath, newName);

        //check if old attachment folder exists and is necessary to rename Folder
        if(await this.adapter.exists(oldAttachmentFolderPath) && (oldAttachmentFolderPath !== newAttachmentFolderPath))
        {
            let tfolder: TAbstractFile = this.app.vault.getAbstractFileByPath(oldAttachmentFolderPath);

            if(tfolder == null)
                return;

            await this.app.fileManager.renameFile(tfolder, newAttachmentFolderPath);
            this.updateAttachmentFolderConfig(this.getAttachmentFolderPath(newName,folderName));
        }

        //if autoRenameFiles is off
        if(!this.settings.autoRenameFiles)
            return;

        let embeds = this.app.metadataCache.getCache(newFile.path)?.embeds;
        if(!embeds)
            return;

        let files: string[] = [];

        for(let embed of embeds)
        {
            let link = embed.link;
            if(link.endsWith('.png') || link.endsWith('jpeg'))
                files.push(Path.basename(link));
            else
                continue;

        }

        let attachmentFiles: ListedFiles= await this.adapter.list(newAttachmentFolderPath);
        for(let file of attachmentFiles.files)
        {
            console.log(file);
            let filePath = file;
            let fileName = Path.basename(filePath);
            if((files.indexOf(fileName) > -1) && fileName.contains(oldName))
            {
                fileName = fileName.replace(oldName, newName);
                let newFilePath = normalizePath(Path.join(newAttachmentFolderPath, fileName));
                let tfile = this.app.vault.getAbstractFileByPath(filePath);
                await this.app.fileManager.renameFile(tfile, newFilePath);
            }
            else
                continue;
        }
    }
}

class CustomAttachmentLocationSettingTab extends PluginSettingTab {
    plugin: CustomAttachmentLocation;

    constructor(app: App, plugin: CustomAttachmentLocation) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        let {containerEl} = this;

        containerEl.empty();

        containerEl.createEl('h2', {text: 'Custom Attachment Location'});

        let el = new Setting(containerEl)
            .setName('Location for New Attachments')
            .setDesc('Start with "./" to use relative path. Available variables: ${filename} ${foldername}.(NOTE: DO NOT start with "/" or end with "/". )')
            .addText(text => text
                .setPlaceholder('media/${foldername}/${filename}')
                .setValue(this.plugin.settings.attachmentFolderPath)
                .onChange(async (value: string) => {
                    console.log('attachmentFolder: ' + value);
                    value = normalizePath(value);
                    console.log('normalized attachmentFolder: ' + value);

                    this.plugin.settings.attachmentFolderPath = value;
                    if(value.startsWith('./'))
                        this.plugin.useRelativePath = true;
                    else
                        this.plugin.useRelativePath = false;
                    await this.plugin.saveSettings();
                }));
        el.controlEl.addEventListener('change',  (()=>{this.display();}));


        new Setting(containerEl)
            .setName('Pasted Image Name')
            .setDesc('Available variables: ${filename}, ${date}, ${foldername}.')
            .addText(text => text
                .setPlaceholder('image-${date}')
                .setValue(this.plugin.settings.pastedImageFileName)
                .onChange(async (value: string) => {
                    console.log('pastedImageFileName: ' + value);
                    this.plugin.settings.pastedImageFileName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Date Format')
            .setDesc('YYYYMMDDHHmmssSSS')
            .addMomentFormat(text => text
                .setDefaultFormat('YYYYMMDDHHmmssSSS')
                .setValue(this.plugin.settings.dateTimeFormat)
                .onChange(async (value: string) => {
                    console.log('dateTimeFormat: ' + value);
                    this.plugin.settings.dateTimeFormat = value || 'YYYYMMDDHHmmssSSS';
                    await this.plugin.saveSettings();
                }));


        new Setting(containerEl)
            .setName('Automatically rename attachment folder')
            .setDesc('When renaming md files, automatically rename attachment folder if folder name contains "${filename}".')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoRenameFolder)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.autoRenameFolder = value;
                    this.display();
                    await this.plugin.saveSettings();
                }));

        if(this.plugin.settings.autoRenameFolder)
            new Setting(containerEl)
            .setName('Automatically rename attachment files [Experimental]')
            .setDesc('When renaming md files, automatically rename attachment files if file name contains "${filename}".')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoRenameFiles)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.autoRenameFiles = value;
                    await this.plugin.saveSettings();
                }));
    }
}
