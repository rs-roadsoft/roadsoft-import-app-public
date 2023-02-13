let languagePack = {
    en: {
        companyId: "Company ID",
        apiKey: "API Key",
        connect: "Connect",
        logs: "Logs",
        selectFolder: "Select Folsder",
        currentFolder: "Current Folder",
        syncTrigger: "Sync Trigger",
        syncTriggerOptions: {
            "Manual": "",
            "Application Start": "application_start",
            "Every hour": "1H",
            "Every 12 hours": "12H",
            "Every 24 hours": "24H",
        },
        scheduleSync: "Schedule Sync",
        syncNow: "Sync Now",
        lastSync: "Last Sync at:",
        dataTableLangUrl: "https://cdn.datatables.net/plug-ins/1.12.1/i18n/en-GB.json"
    }
}

function changeLanguage(textObj) {
    $('label[for="company-id"]').text(textObj.companyId)
    $('label[for="api-key"]').text(textObj.apiKey)
    $('button#connect').text(textObj.connect)
    $('.logsText').text(textObj.logs)
    $('#selectFolder').text(textObj.selectFolder)
    $('#currentFolder').text(textObj.currentFolder)
    $('#currentFolder').text(textObj.currentFolder)
    $('label[for="sync-trigger"]').text(textObj.syncTrigger);
    $('#scheduleSync').text(textObj.scheduleSync);
    $('#syncNow').text(textObj.syncNow);
    $('#lastSync').text(textObj.lastSync);

    $("#trigger").empty();
    let size = Object.keys(textObj.syncTriggerOptions).length;
    for(let i = 0; i < size; i++) {
        $("#trigger").append(`<option value="${Object.values(textObj.syncTriggerOptions)[i]}">${Object.keys(textObj.syncTriggerOptions)[i]}</option>`)
    }
}

$("#changeLanguage").on("change", e => {
    let textObj = languagePack[$(e.target).val()];

    if(textObj) {
        changeLanguage(textObj);
    }
})