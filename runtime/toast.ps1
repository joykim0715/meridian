$ErrorActionPreference = "Stop"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$title = $env:SBHNEWS_TOAST_TITLE
$body = $env:SBHNEWS_TOAST_BODY
if ([string]::IsNullOrEmpty($title)) { $title = "SBHNews Daily Briefing" }
if ($null -eq $body) { $body = "" }

$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $template.GetElementsByTagName("text")
[void]$nodes.Item(0).AppendChild($template.CreateTextNode($title))
[void]$nodes.Item(1).AppendChild($template.CreateTextNode($body))
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
