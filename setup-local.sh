#!/usr/bin/env bash
# setup-local.sh — levanta el entorno local completo en un solo comando
# Requisitos previos: brew install colima docker kubectl helm k3d argocd
set -euo pipefail

CLUSTER_NAME="demo-cluster"
ARGOCD_NS="argocd"
OBSERVABILITY_REPO="https://github.com/cokee96/observability-stack"

echo "──────────────────────────────────────────────"
echo " 1/6  Iniciando Colima (Docker runtime)"
echo "──────────────────────────────────────────────"
if ! colima status 2>/dev/null | grep -q "Running"; then
  colima start --cpu 4 --memory 8 --disk 60 --arch aarch64 --vm-type vz --vz-rosetta
fi
echo "Colima OK"

echo "──────────────────────────────────────────────"
echo " 2/6  Creando cluster k3d"
echo "──────────────────────────────────────────────"
if k3d cluster list | grep -q "$CLUSTER_NAME"; then
  echo "Cluster '$CLUSTER_NAME' ya existe — saltando"
else
  k3d cluster create "$CLUSTER_NAME" \
    --agents 2 \
    --port "8080:80@loadbalancer" \
    --port "8443:443@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0"   # usaremos nginx-ingress
  echo "Cluster creado"
fi
kubectl cluster-info

echo "──────────────────────────────────────────────"
echo " 3/6  Construyendo imagen demo-app"
echo "──────────────────────────────────────────────"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
docker build -t demo-app:latest "$SCRIPT_DIR"
k3d image import demo-app:latest -c "$CLUSTER_NAME"
echo "Imagen importada en el cluster"

echo "──────────────────────────────────────────────"
echo " 4/6  Instalando ArgoCD"
echo "──────────────────────────────────────────────"
kubectl create namespace "$ARGOCD_NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n "$ARGOCD_NS" \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
echo "Esperando a que ArgoCD esté listo..."
kubectl rollout status deployment/argocd-server -n "$ARGOCD_NS" --timeout=180s

echo "──────────────────────────────────────────────"
echo " 5/6  Aplicando App of Apps (observability)"
echo "──────────────────────────────────────────────"
# Parchear argocd-cm para que conozca el entorno
kubectl patch configmap argocd-cm -n "$ARGOCD_NS" \
  --patch '{"data":{"environment":"dev"}}' 2>/dev/null || true

# Root app apunta al repo de observabilidad
cat <<EOF | kubectl apply -f -
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.io
spec:
  project: default
  source:
    repoURL: ${OBSERVABILITY_REPO}
    targetRevision: HEAD
    path: argocd/apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
EOF
echo "Root app aplicada — ArgoCD desplegará Prometheus, Grafana y Loki automáticamente"

echo "──────────────────────────────────────────────"
echo " 6/6  Desplegando microservicio demo-app"
echo "──────────────────────────────────────────────"
kubectl apply -f "$SCRIPT_DIR/k8s/"
kubectl rollout status deployment/demo-app -n demo --timeout=120s

echo ""
echo "══════════════════════════════════════════════"
echo " LISTO — Accesos:"
echo "══════════════════════════════════════════════"
ARGOCD_PASS=$(kubectl get secret argocd-initial-admin-secret \
  -n argocd -o jsonpath="{.data.password}" | base64 -d)
echo ""
echo "  ArgoCD UI:"
echo "    kubectl port-forward svc/argocd-server -n argocd 9090:443"
echo "    https://localhost:9090  (admin / ${ARGOCD_PASS})"
echo ""
echo "  Grafana (disponible tras ~3 min mientras ArgoCD sincroniza):"
echo "    kubectl port-forward svc/kube-prometheus-stack-grafana -n monitoring 3000:80"
echo "    http://localhost:3000  (admin / prom-operator)"
echo ""
echo "  Prometheus:"
echo "    kubectl port-forward svc/kube-prometheus-stack-prometheus -n monitoring 9091:9090"
echo "    http://localhost:9091"
echo ""
echo "  demo-app:"
echo "    kubectl port-forward svc/demo-app -n demo 8081:80"
echo "    http://localhost:8081        → respuesta JSON"
echo "    http://localhost:8081/healthz → health check"
echo "    http://localhost:8081/metrics → métricas Prometheus"
echo ""
echo "  Para generar tráfico:"
echo "    while true; do curl -s http://localhost:8081 > /dev/null; sleep 0.5; done"
echo "══════════════════════════════════════════════"
