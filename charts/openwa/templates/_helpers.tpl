{{- define "openwa.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "openwa.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "openwa.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "openwa.labels" -}}
helm.sh/chart: {{ include "openwa.chart" . }}
{{ include "openwa.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "openwa.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openwa.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "openwa.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openwa.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "openwa.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- include "openwa.fullname" . }}
{{- end }}
{{- end }}
