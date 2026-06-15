$body = @{
  host = if ($env:SMTP_HOST) { $env:SMTP_HOST } else { "smtp.gmail.com" }
  port = if ($env:SMTP_PORT) { $env:SMTP_PORT } else { 465 }
  secure = if ($env:SMTP_SECURE) { $env:SMTP_SECURE } else { "true" }
  user = $env:SMTP_USER
  pass = $env:SMTP_PASS
  from = $env:SMTP_FROM
  fromName = "Test"
  to = "carlos.tech04@gmail.com"
  subject = "Test from Render"
  body = "<h1>Working!</h1><p>Email sent via Render backend</p>"
  trackingId = "test_" + (Get-Random)
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://email-filter-sdq0.onrender.com/send" -Method Post -Body $body -ContentType "application/json"
