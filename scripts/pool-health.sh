#!/bin/bash
# pool-health.sh - Monitor worker pool health and detect stuck/crashed workers
#
# Usage:
#   ./scripts/pool-health.sh                    # Check health once
#   ./scripts/pool-health.sh --watch            # Continuous monitoring
#   ./scripts/pool-health.sh --restart-stuck    # Auto-restart stuck workers
#
# Exit codes:
#   0 - All workers healthy
#   1 - Some workers unhealthy
#   2 - All workers down

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
STUCK_THRESHOLD_MINUTES=${STUCK_THRESHOLD_MINUTES:-30}  # No log activity for N minutes = stuck
POLL_INTERVAL=${HEALTH_CHECK_INTERVAL:-60}              # Seconds between health checks in watch mode
AUTO_RESTART=${AUTO_RESTART:-false}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_debug() {
    if [[ "${DEBUG:-}" == "1" ]]; then
        echo -e "${BLUE}[DEBUG]${NC} $1"
    fi
}

usage() {
    cat << 'EOF'
Usage: ./scripts/pool-health.sh [OPTIONS]

Monitor worker pool health and detect issues.

Options:
  --watch             Continuous monitoring (checks every minute)
  --restart-stuck     Auto-restart workers stuck for >30min
  --threshold N       Set stuck threshold in minutes (default: 30)
  --help, -h          Show this help

Examples:
  ./scripts/pool-health.sh
  ./scripts/pool-health.sh --watch
  ./scripts/pool-health.sh --restart-stuck --threshold 15

Environment Variables:
  STUCK_THRESHOLD_MINUTES    Minutes of inactivity before worker is stuck (default: 30)
  HEALTH_CHECK_INTERVAL      Seconds between checks in watch mode (default: 60)
  AUTO_RESTART              Auto-restart stuck workers (default: false)
EOF
    exit 0
}

# Parse arguments
WATCH_MODE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --watch)
            WATCH_MODE=true
            shift
            ;;
        --restart-stuck)
            AUTO_RESTART=true
            shift
            ;;
        --threshold)
            STUCK_THRESHOLD_MINUTES="$2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Check if any workers are running
get_worker_containers() {
    docker ps --filter "name=worker" --format "{{.Names}}" | grep -E "(worker-[0-9]+|worker_[0-9]+)" | sort
}

# Get last log activity for a worker
get_last_activity() {
    local worker=$1
    local log_dir="${PROJECT_ROOT}/pool-logs"

    if [[ ! -d "$log_dir" ]]; then
        echo "0"
        return
    fi

    # Get worker ID from container name
    local worker_id
    worker_id=$(docker inspect "$worker" --format '{{.Config.Hostname}}' 2>/dev/null || echo "")

    if [[ -z "$worker_id" ]]; then
        echo "0"
        return
    fi

    # Find most recent log file for this worker
    local latest_log
    latest_log=$(find "$log_dir" -name "worker-${worker_id}_*.log" -type f 2>/dev/null | sort -r | head -1)

    if [[ -z "$latest_log" ]]; then
        echo "0"
        return
    fi

    # Get modification time in seconds since epoch
    stat -f %m "$latest_log" 2>/dev/null || echo "0"
}

# Check if worker is actively polling
is_polling() {
    local worker=$1
    local since_seconds=120  # Check last 2 minutes of logs

    # Check docker logs for polling activity (don't exit on grep failure)
    if docker logs --since "${since_seconds}s" "$worker" 2>&1 | grep -q "Polling for issues" 2>/dev/null || false; then
        return 0  # Is polling
    else
        return 1  # Not polling
    fi
}

# Get worker uptime
get_uptime() {
    local worker=$1

    # Use docker inspect to get uptime directly (works cross-platform)
    local status
    status=$(docker inspect "$worker" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")

    if [[ "$status" != "running" ]]; then
        echo "not running"
        return
    fi

    # Get uptime in human-readable format using docker stats --no-stream
    # This is more portable than parsing timestamps
    local uptime_raw
    uptime_raw=$(docker inspect "$worker" --format '{{.State.StartedAt}}' 2>/dev/null || echo "")

    if [[ -z "$uptime_raw" ]]; then
        echo "unknown"
        return
    fi

    # Use Python to parse ISO8601 timestamp (more portable than date command)
    local uptime_seconds
    uptime_seconds=$(python3 -c "
from datetime import datetime, timezone
import sys
started = '$uptime_raw'
start_time = datetime.fromisoformat(started.replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
uptime = int((now - start_time).total_seconds())
print(uptime)
" 2>/dev/null || echo "0")

    if [[ "$uptime_seconds" == "0" ]]; then
        echo "unknown"
        return
    fi

    # Convert to human readable
    local hours=$((uptime_seconds / 3600))
    local minutes=$(((uptime_seconds % 3600) / 60))

    if [[ $hours -lt 1 ]]; then
        echo "${minutes}m"
    else
        echo "${hours}h ${minutes}m"
    fi
}

# Count issues processed by worker
count_issues_processed() {
    local worker=$1
    local log_dir="${PROJECT_ROOT}/pool-logs"

    if [[ ! -d "$log_dir" ]]; then
        echo "0"
        return
    fi

    local worker_id
    worker_id=$(docker inspect "$worker" --format '{{.Config.Hostname}}' 2>/dev/null || echo "")

    if [[ -z "$worker_id" ]]; then
        echo "0"
        return
    fi

    # Count "Successfully claimed issue" occurrences in all logs for this worker
    local count
    count=$(grep -h "Successfully claimed issue" "$log_dir"/worker-"${worker_id}"_*.log 2>/dev/null | wc -l | tr -d ' ')
    if [[ -z "$count" ]] || [[ "$count" == "0" ]]; then
        echo "0"
    else
        echo "$count"
    fi
}

# Restart a worker
restart_worker() {
    local worker=$1
    log_warn "Restarting worker: $worker"

    if docker restart "$worker" >/dev/null 2>&1; then
        log_info "  ✅ Worker restarted successfully"
        return 0
    else
        log_error "  ❌ Failed to restart worker"
        return 1
    fi
}

# Main health check
check_health() {
    local workers
    workers=$(get_worker_containers)

    if [[ -z "$workers" ]]; then
        log_error "No workers found running"
        return 2
    fi

    local total_workers=0
    local healthy_workers=0
    local stuck_workers=0
    local crashed_workers=0
    local now_epoch
    now_epoch=$(date +%s)
    local stuck_threshold_seconds=$((STUCK_THRESHOLD_MINUTES * 60))

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Worker Pool Health Check"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    printf "%-30s %-12s %-15s %-10s %-15s\n" "WORKER" "STATUS" "UPTIME" "ISSUES" "LAST ACTIVITY"
    printf "%-30s %-12s %-15s %-10s %-15s\n" "------" "------" "------" "------" "-------------"

    while IFS= read -r worker; do
        ((total_workers++))

        local status="UNKNOWN"
        local uptime
        uptime=$(get_uptime "$worker")
        local issues_processed
        issues_processed=$(count_issues_processed "$worker")
        local last_activity_epoch
        last_activity_epoch=$(get_last_activity "$worker")
        local last_activity_str="never"

        if [[ "$last_activity_epoch" != "0" ]]; then
            local inactive_seconds=$((now_epoch - last_activity_epoch))
            local inactive_minutes=$((inactive_seconds / 60))

            if [[ $inactive_minutes -lt 1 ]]; then
                last_activity_str="<1m ago"
            elif [[ $inactive_minutes -lt 60 ]]; then
                last_activity_str="${inactive_minutes}m ago"
            else
                local inactive_hours=$((inactive_minutes / 60))
                last_activity_str="${inactive_hours}h ago"
            fi

            # Check if stuck
            if [[ $inactive_seconds -gt $stuck_threshold_seconds ]]; then
                status="STUCK"
                ((stuck_workers++))
            fi
        fi

        # Check if polling
        if is_polling "$worker"; then
            if [[ "$status" == "UNKNOWN" ]]; then
                status="HEALTHY"
                ((healthy_workers++))
            fi
        else
            if [[ "$status" == "UNKNOWN" ]]; then
                status="IDLE"
                ((healthy_workers++))
            fi
        fi

        # Check if container is actually running
        local is_running
        is_running=$(docker inspect "$worker" --format '{{.State.Running}}' 2>/dev/null || echo "false")
        if [[ "$is_running" != "true" ]]; then
            status="CRASHED"
            ((crashed_workers++))
        fi

        # Color code status
        local status_colored
        case $status in
            HEALTHY)
                status_colored="${GREEN}${status}${NC}"
                ;;
            IDLE)
                status_colored="${BLUE}${status}${NC}"
                ;;
            STUCK)
                status_colored="${YELLOW}${status}${NC}"
                ;;
            CRASHED)
                status_colored="${RED}${status}${NC}"
                ;;
            *)
                status_colored="$status"
                ;;
        esac

        printf "%-30s %-20s %-15s %-10s %-15s\n" \
            "$worker" \
            "$(echo -e "$status_colored")" \
            "$uptime" \
            "$issues_processed" \
            "$last_activity_str"

        # Auto-restart if enabled and stuck
        if [[ "$AUTO_RESTART" == "true" ]] && [[ "$status" == "STUCK" ]]; then
            restart_worker "$worker"
        fi

    done <<< "$workers"

    echo ""
    echo "Summary:"
    echo "  Total workers:     $total_workers"
    echo "  Healthy/Idle:      $healthy_workers"
    echo "  Stuck (>${STUCK_THRESHOLD_MINUTES}min): $stuck_workers"
    echo "  Crashed:           $crashed_workers"
    echo ""

    if [[ $stuck_workers -gt 0 ]] || [[ $crashed_workers -gt 0 ]]; then
        if [[ "$AUTO_RESTART" == "true" ]]; then
            log_warn "Some workers are unhealthy (auto-restart enabled)"
        else
            log_warn "Some workers are unhealthy. Run with --restart-stuck to auto-restart."
        fi
        return 1
    else
        log_info "All workers are healthy!"
        return 0
    fi
}

# Main execution
main() {
    if [[ "$WATCH_MODE" == "true" ]]; then
        log_info "Starting continuous health monitoring (interval: ${POLL_INTERVAL}s)"
        log_info "Press Ctrl+C to stop"
        echo ""

        while true; do
            check_health || true  # Don't exit on unhealthy
            sleep "$POLL_INTERVAL"
            clear
        done
    else
        check_health
    fi
}

main
